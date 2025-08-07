const pool = require('../config/db');

exports.getAssignments = async (req, res) => {
  try {
    const { userId } = req.params;
    const [assignments] = await pool.query(`
      SELECT ta.* FROM test_assignments ta
      JOIN assignment_categories ac ON ta.id = ac.assignment_id
      LEFT JOIN (
        SELECT q.category_id, COUNT(*) as mastered_count
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.id
        WHERE ur.user_id = ? AND ur.status = 'sure_correct'
        GROUP BY q.category_id
      ) mastered ON ac.category_id = mastered.category_id
      WHERE mastered.mastered_count IS NULL OR mastered.mastered_count < ac.question_count
      GROUP BY ta.id
    `, [userId]);

    res.status(200).json({ success: true, assignments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAssignmentQuestions = async (req, res) => {
  try {
    const { userId, assignmentId } = req.params;
    const conn = await pool.getConnection();
    
    try {
      // Get assignment categories and question counts
      const [categories] = await conn.query(
        'SELECT c.id as category_id, c.name as category_name, ac.question_count ' +
        'FROM assignment_categories ac ' +
        'JOIN categories c ON ac.category_id = c.id ' +
        'WHERE ac.assignment_id = ?',
        [assignmentId]
      );

      const categoryQuestions = [];
      
      for (const category of categories) {
        // Get questions the user hasn't mastered yet in this category
        const [questions] = await conn.query(`
          SELECT q.* FROM questions q
          LEFT JOIN user_responses ur ON q.id = ur.question_id AND ur.user_id = ? AND ur.status = 'sure_correct'
          WHERE q.category_id = ? AND ur.id IS NULL
          ORDER BY RAND()
          LIMIT ?
        `, [userId, category.category_id, category.question_count]);

        if (questions.length > 0) {
          categoryQuestions.push({
            category_id: category.category_id,
            category_name: category.category_name,
            questions: questions.map(q => ({
              ...q,
              options: JSON.parse(q.options) // Parse JSON options if needed
            }))
          });
        }
      }

      res.status(200).json({ 
        success: true, 
        questions: categoryQuestions 
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};



exports.getUserProgress = async (req, res) => {
  try {
    const { userId } = req.params;
    const conn = await pool.getConnection();
    
    try {
      // 1. Get overall progress statistics
      const [overallStats] = await conn.query(`
        SELECT 
          COUNT(DISTINCT ur.assignment_id) as total_assignments,
          COUNT(DISTINCT q.category_id) as total_categories,
          COUNT(ur.id) as total_questions_attempted,
          SUM(CASE WHEN ur.status = 'sure_correct' THEN 1 ELSE 0 END) as mastered_questions,
          SUM(CASE WHEN ur.answer = q.correct_answer THEN 1 ELSE 0 END) as correct_answers,
          SUM(CASE WHEN ur.answer != q.correct_answer THEN 1 ELSE 0 END) as incorrect_answers,
          SUM(CASE WHEN ur.status IN ('sure_correct', 'sure_incorrect') THEN 1 ELSE 0 END) as confident_responses,
          SUM(CASE WHEN ur.status IN ('not_sure_correct', 'not_sure_incorrect') THEN 1 ELSE 0 END) as unsure_responses
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.id
        WHERE ur.user_id = ?
      `, [userId]);

      // Calculate percentages
      const stats = overallStats[0] || {};
      stats.accuracy = stats.total_questions_attempted > 0 
        ? Math.round((stats.correct_answers / stats.total_questions_attempted) * 100)
        : 0;
      stats.confidence = stats.total_questions_attempted > 0
        ? Math.round((stats.confident_responses / stats.total_questions_attempted) * 100)
        : 0;
      stats.mastery = stats.total_questions_attempted > 0
        ? Math.round((stats.mastered_questions / stats.total_questions_attempted) * 100)
        : 0;

      // 2. Get category-wise progress
      const [categoryProgress] = await conn.query(`
        SELECT 
          c.id as category_id,
          c.name as category_name,
          COUNT(q.id) as total_questions_in_category,
          COUNT(ur.id) as questions_attempted,
          SUM(CASE WHEN ur.status = 'sure_correct' THEN 1 ELSE 0 END) as mastered_questions,
          SUM(CASE WHEN ur.answer = q.correct_answer THEN 1 ELSE 0 END) as correct_answers,
          SUM(CASE WHEN ur.answer != q.correct_answer THEN 1 ELSE 0 END) as incorrect_answers,
          SUM(CASE WHEN ur.status IN ('sure_correct', 'sure_incorrect') THEN 1 ELSE 0 END) as confident_responses
        FROM categories c
        LEFT JOIN questions q ON c.id = q.category_id
        LEFT JOIN user_responses ur ON q.id = ur.question_id AND ur.user_id = ?
        GROUP BY c.id, c.name
        ORDER BY c.name
      `, [userId]);

      // Format category progress with percentages
      const formattedCategories = categoryProgress.map(cat => {
        const accuracy = cat.questions_attempted > 0 
          ? Math.round((cat.correct_answers / cat.questions_attempted) * 100)
          : 0;
        const confidence = cat.questions_attempted > 0
          ? Math.round((cat.confident_responses / cat.questions_attempted) * 100)
          : 0;
        const mastery = cat.questions_attempted > 0
          ? Math.round((cat.mastered_questions / cat.questions_attempted) * 100)
          : 0;
        
        return {
          categoryId: cat.category_id,
          categoryName: cat.category_name,
          totalQuestions: cat.total_questions_in_category,
          questionsAttempted: cat.questions_attempted,
          masteredQuestions: cat.mastered_questions,
          correctAnswers: cat.correct_answers,
          incorrectAnswers: cat.incorrect_answers,
          accuracy,
          confidence,
          mastery,
          completionPercentage: cat.total_questions_in_category > 0
            ? Math.round((cat.questions_attempted / cat.total_questions_in_category) * 100)
            : 0
        };
      });

      // 3. Get recent activity (last 5 responses)
      const [recentActivity] = await conn.query(`
        SELECT 
          ur.id as response_id,
          ur.question_id,
          ur.status,
          ur.answer as user_answer,
          ur.created_at as response_time,
          q.question,
          q.correct_answer,
          c.name as category_name
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.id
        JOIN categories c ON q.category_id = c.id
        WHERE ur.user_id = ?
        ORDER BY ur.created_at DESC
        LIMIT 5
      `, [userId]);

      // Format recent activity
      const formattedActivity = recentActivity.map(activity => ({
        responseId: activity.response_id,
        questionId: activity.question_id,
        question: activity.question,
        category: activity.category_name,
        userAnswer: activity.user_answer,
        correctAnswer: activity.correct_answer,
        status: activity.status,
        isCorrect: activity.user_answer === activity.correct_answer,
        responseTime: activity.response_time
      }));

      res.status(200).json({ 
        success: true, 
        progress: {
          overallStats: stats,
          categories: formattedCategories,
          recentActivity: formattedActivity
        }
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};

exports.register = async (req, res) => {
  try {
    const { email, password, isAdmin } = req.body;
    const [result] = await pool.query(
      'INSERT INTO users (email, password, is_admin) VALUES (?, ?, ?)',
      [email, password, isAdmin]
    );

    res.status(201).json({ success: true, userId: result.insertId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = users[0];
    
    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // In a real app, you'd generate a token here
    res.status(200).json({ 
      success: true, 
      user: {
        id: user.id,
        email: user.email,
        isAdmin: user.is_admin
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.submitAssignment = async (req, res) => {
  try {
    const { assignmentId, userId } = req.params;
    const { responses } = req.body;
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    try {
      // Check if user already completed this assignment
      const [completion] = await conn.query(
        'SELECT is_completed FROM user_assignment_completion WHERE user_id = ? AND assignment_id = ?',
        [userId, assignmentId]
      );
      
      if (completion.length > 0 && completion[0].is_completed) {
        throw new Error('Assignment already completed by this user');
      }

      const results = [];
      
      // Process each response
      for (const response of responses) {
        const [questions] = await conn.query(
          'SELECT correct_answer, short_content, long_content_text, long_content_file_path FROM questions WHERE id = ?',
          [response.questionId]
        );
        const question = questions[0];
        
        const isCorrect = response.answer === question.correct_answer;
        const status = response.isSure 
          ? (isCorrect ? 'sure_correct' : 'sure_incorrect')
          : (isCorrect ? 'not_sure_correct' : 'not_sure_incorrect');

        // Save response
        await conn.query(
          'INSERT INTO user_responses (user_id, question_id, assignment_id, status, answer, is_sure) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, response.questionId, assignmentId, status, response.answer, response.isSure]
        );

        // Prepare result
        const result = {
          questionId: response.questionId,
          status,
          correctAnswer: question.correct_answer,
          userAnswer: response.answer,
          isSure: response.isSure
        };

        // Add feedback based on status
        switch (status) {
          case 'sure_incorrect':
          case 'not_sure_incorrect':
            result.feedback = {
              longContent: {
                text: question.long_content_text,
                filePath: question.long_content_file_path
              }
            };
            break;
          case 'not_sure_correct':
            result.feedback = {
              shortContent: question.short_content
            };
            break;
          // No feedback for 'sure_correct'
        }

        results.push(result);
      }

      // Mark assignment as completed for this user
      await conn.query(
        'INSERT INTO user_assignment_completion (user_id, assignment_id, is_completed, completed_at) VALUES (?, ?, TRUE, NOW()) ON DUPLICATE KEY UPDATE is_completed = TRUE, completed_at = NOW()',
        [userId, assignmentId]
      );

      await conn.commit();
      res.status(200).json({
        success: true,
        results,
        assignmentCompleted: true
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
};
exports.getAssignmentResults = async (req, res) => {
  try {
    const { userId, assignmentId } = req.params;
    const conn = await pool.getConnection();

    try {
      // Verify user completed the assignment
      const [completion] = await conn.query(
        'SELECT * FROM user_assignment_completion WHERE user_id = ? AND assignment_id = ? AND is_completed = TRUE',
        [userId, assignmentId]
      );

      if (completion.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Assignment not completed by this user'
        });
      }

      // Get assignment details
      const [assignment] = await conn.query(
        'SELECT * FROM test_assignments WHERE id = ?',
        [assignmentId]
      );

      // Get all responses with question details
      const [responses] = await conn.query(`
        SELECT 
          ur.id as response_id,
          ur.question_id,
          ur.answer as user_answer,
          ur.status,
          ur.is_sure,
          ur.created_at as response_time,
          q.question,
          q.options,
          q.correct_answer,
          q.short_content,
          q.long_content_text,
          q.long_content_file_path,
          c.name as category_name
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.id
        JOIN categories c ON q.category_id = c.id
        WHERE ur.user_id = ? AND ur.assignment_id = ?
        ORDER BY ur.created_at
      `, [userId, assignmentId]);

      // Format the response to match submitAssignment structure
      const formattedResponses = responses.map(response => {
        const isCorrect = response.user_answer === response.correct_answer;
        const status = response.status || 
                      (response.is_sure 
                        ? (isCorrect ? 'sure_correct' : 'sure_incorrect')
                        : (isCorrect ? 'not_sure_correct' : 'not_sure_incorrect'));

        // Determine feedback based on status
       // In your getAssignmentResults controller, modify the feedback object creation:
let feedback = {
  short: null,
  long: {
    text: null,
    filePath: null
  }
};

switch(status) {
  case 'not_sure_incorrect':
  case 'sure_incorrect':
    feedback.long = {
      text: response.long_content_text,
      filePath: response.long_content_file_path
    };
    break;
  case 'not_sure_correct':
    feedback.short = response.short_content;
    break;
  // 'sure_correct' will return the empty feedback object
}

        return {
          questionId: response.question_id,
          status,
          correctAnswer: response.correct_answer,
          userAnswer: response.user_answer,
          isSure: Boolean(response.is_sure),
          feedback,
          question: response.question,
          options: response.options,
          category: response.category_name,
          responseTime: response.response_time
        };
      });

      res.status(200).json({
        success: true,
        assignment: {
          id: assignmentId,
          name: assignment[0].name,
          completedAt: completion[0].completed_at,
          responses: formattedResponses
        }
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

  // Add this to your userController.js
exports.getUserAssignmentCompletionDetails = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [assignments] = await pool.query(`
      SELECT 
        ta.id,
        ta.name,
        ta.created_at,
        uac.is_completed,
        uac.completed_at,
        COUNT(ac.category_id) as category_count,
        SUM(ac.question_count) as total_questions,
        (
          SELECT COUNT(*) 
          FROM user_responses ur 
          WHERE ur.assignment_id = ta.id AND ur.user_id = ? AND ur.status = 'sure_correct'
        ) as mastered_questions
      FROM test_assignments ta
      LEFT JOIN user_assignment_completion uac ON ta.id = uac.assignment_id AND uac.user_id = ?
      LEFT JOIN assignment_categories ac ON ta.id = ac.assignment_id
      GROUP BY ta.id, ta.name, ta.created_at, uac.is_completed, uac.completed_at
      ORDER BY ta.created_at
    `, [userId, userId]);

    // Format the response with additional calculated fields
    const formattedAssignments = assignments.map(assignment => ({
      id: assignment.id,
      name: assignment.name,
      createdAt: assignment.created_at,
      isCompleted: Boolean(assignment.is_completed),
      completedAt: assignment.completed_at,
      stats: {
        totalCategories: assignment.category_count,
        totalQuestions: assignment.total_questions,
        masteredQuestions: assignment.mastered_questions,
        masteryPercentage: assignment.total_questions > 0 
          ? Math.round((assignment.mastered_questions / assignment.total_questions) * 100)
          : 0
      }
    }));

    res.status(200).json({ 
      success: true, 
      assignments: formattedAssignments 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};



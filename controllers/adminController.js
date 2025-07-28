const pool = require('../config/db');
const multer = require('multer');
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

exports.uploadMiddleware = () => upload.fields([
  { name: 'longContentFile', maxCount: 1 },
  { name: 'questionMedia', maxCount: 1 }
]);

exports.addCategory = async (req, res) => {
  try {
    const { name } = req.body;
    const [result] = await pool.query('INSERT INTO categories (name) VALUES (?)', [name]);
    res.status(201).json({ success: true, categoryId: result.insertId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.addQuestion = async (req, res) => {
  try {
    const { categoryId, question, options, correctAnswer, shortContent, longContentText } = req.body;
    const longContentFilePath = req.files['longContentFile'] ? `/uploads/${req.files['longContentFile'][0].filename}` : null;
    const questionMediaPath = req.files['questionMedia'] ? `/uploads/${req.files['questionMedia'][0].filename}` : null;

    const [result] = await pool.query(
      'INSERT INTO questions (category_id, question, question_media_path, options, correct_answer, short_content, long_content_text, long_content_file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [categoryId, question, questionMediaPath, JSON.stringify(options), correctAnswer, shortContent, longContentText, longContentFilePath]
    );

    res.status(201).json({ success: true, questionId: result.insertId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.bulkAddQuestions = async (req, res) => {
  try {
    const { questions } = req.body;
    const parsedQuestions = JSON.parse(questions).map(q => [
      q.categoryId,
      q.question,
      JSON.stringify(q.options),
      q.correctAnswer,
      q.shortContent,
      q.longContentText,
      null // Files would need to be handled differently for bulk upload
    ]);

    const [result] = await pool.query(
      'INSERT INTO questions (category_id, question, options, correct_answer, short_content, long_content_text, long_content_file_path) VALUES ?',
      [parsedQuestions]
    );

    res.status(201).json({ success: true, affectedRows: result.affectedRows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.createTestAssignment = async (req, res) => {
  try {
    const { adminId, name, categoryQuestions } = req.body;
    
    // No need to parse if you send proper JSON from client
    // const parsedCategoryQuestions = JSON.parse(categoryQuestions); // Remove this line
    
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    try {
      // Create the test assignment
      const [assignmentResult] = await conn.query(
        'INSERT INTO test_assignments (admin_id, name) VALUES (?, ?)',
        [adminId, name]
      );
      const assignmentId = assignmentResult.insertId;

      // Add category-question mappings
      const assignmentCategories = [];
      for (const [categoryId, questionCount] of Object.entries(categoryQuestions)) {
        const [result] = await conn.query(
          'INSERT INTO assignment_categories (assignment_id, category_id, question_count) VALUES (?, ?, ?)',
          [assignmentId, categoryId, questionCount]
        );
        assignmentCategories.push({
          id: result.insertId,
          categoryId,
          questionCount
        });
      }

      await conn.commit();
      res.status(201).json({ 
        success: true, 
        assignmentId, 
        assignmentCategories 
      });
    } catch (err) {
      await conn.rollback();
      throw err;
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

exports.getAllAssignments = async (req, res) => {
  try {
    const conn = await pool.getConnection();
    
    try {
      // Get all assignments
      const [assignments] = await conn.query(`
        SELECT id, name, created_at 
        FROM test_assignments 
        ORDER BY created_at ASC
      `);

      // Get categories for each assignment
      for (const assignment of assignments) {
        const [categories] = await conn.query(`
          SELECT 
            ac.category_id, 
            c.name as category_name,
            ac.question_count
          FROM assignment_categories ac
          JOIN categories c ON ac.category_id = c.id
          WHERE ac.assignment_id = ?
        `, [assignment.id]);
        
        assignment.categories = categories;
      }

      res.status(200).json({ 
        success: true, 
        assignments 
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

exports.getUserHistoryForAdmin = async (req, res) => {
  try {
    const { userId } = req.params;
    const conn = await pool.getConnection();
    
    try {
      // 1. Get all assignments the user has attempted
      const [assignments] = await conn.query(`
        SELECT 
          ta.id, 
          ta.name,
          ta.created_at,
          uac.is_completed,
          uac.completed_at
        FROM test_assignments ta
        LEFT JOIN user_assignment_completion uac ON ta.id = uac.assignment_id AND uac.user_id = ?
        WHERE EXISTS (
          SELECT 1 FROM user_responses ur 
          WHERE ur.assignment_id = ta.id AND ur.user_id = ?
        )
        ORDER BY ta.created_at DESC
      `, [userId, userId]);

      // 2. Get detailed performance for each assignment
      for (const assignment of assignments) {
        // Overall assignment stats
        const [overallStats] = await conn.query(`
          SELECT 
            COUNT(*) as total_questions,
            SUM(CASE WHEN ur.answer = q.correct_answer THEN 1 ELSE 0 END) as correct_answers,
            SUM(CASE WHEN ur.answer != q.correct_answer THEN 1 ELSE 0 END) as incorrect_answers,
            SUM(CASE WHEN ur.status IN ('sure_correct', 'not_sure_correct') AND ur.answer = q.correct_answer THEN 1 ELSE 0 END) as correct_confident,
            SUM(CASE WHEN ur.status IN ('sure_incorrect', 'not_sure_incorrect') AND ur.answer != q.correct_answer THEN 1 ELSE 0 END) as incorrect_confident
          FROM user_responses ur
          JOIN questions q ON ur.question_id = q.id
          WHERE ur.assignment_id = ? AND ur.user_id = ?
        `, [assignment.id, userId]);

        assignment.stats = overallStats[0] || {};
        assignment.stats.accuracy = assignment.stats.total_questions > 0 
          ? Math.round((assignment.stats.correct_answers / assignment.stats.total_questions) * 100)
          : 0;

        // Category-wise performance
        const [categoryStats] = await conn.query(`
          SELECT 
            c.id as category_id,
            c.name as category_name,
            COUNT(*) as total_questions,
            SUM(CASE WHEN ur.answer = q.correct_answer THEN 1 ELSE 0 END) as correct_answers,
            SUM(CASE WHEN ur.answer != q.correct_answer THEN 1 ELSE 0 END) as incorrect_answers,
            SUM(CASE WHEN ur.status = 'sure_correct' THEN 1 ELSE 0 END) as sure_correct,
            SUM(CASE WHEN ur.status = 'not_sure_correct' THEN 1 ELSE 0 END) as not_sure_correct,
            SUM(CASE WHEN ur.status = 'sure_incorrect' THEN 1 ELSE 0 END) as sure_incorrect,
            SUM(CASE WHEN ur.status = 'not_sure_incorrect' THEN 1 ELSE 0 END) as not_sure_incorrect
          FROM user_responses ur
          JOIN questions q ON ur.question_id = q.id
          JOIN categories c ON q.category_id = c.id
          WHERE ur.assignment_id = ? AND ur.user_id = ?
          GROUP BY c.id, c.name
        `, [assignment.id, userId]);

        // Calculate percentages for each category
        assignment.categories = categoryStats.map(cat => ({
          ...cat,
          accuracy: cat.total_questions > 0 
            ? Math.round((cat.correct_answers / cat.total_questions) * 100)
            : 0,
          confidence: cat.total_questions > 0
            ? Math.round(((cat.sure_correct + cat.sure_incorrect) / cat.total_questions) * 100)
            : 0
        }));
      }

      // 3. Get overall user statistics across all assignments
      const [userOverallStats] = await conn.query(`
        SELECT 
          COUNT(DISTINCT ur.assignment_id) as total_assignments,
          COUNT(*) as total_questions_attempted,
          SUM(CASE WHEN ur.answer = q.correct_answer THEN 1 ELSE 0 END) as total_correct,
          SUM(CASE WHEN ur.answer != q.correct_answer THEN 1 ELSE 0 END) as total_incorrect,
          SUM(CASE WHEN ur.status IN ('sure_correct', 'not_sure_correct') THEN 1 ELSE 0 END) as total_confident,
          SUM(CASE WHEN ur.status IN ('sure_incorrect', 'not_sure_incorrect') THEN 1 ELSE 0 END) as total_not_confident
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.id
        WHERE ur.user_id = ?
      `, [userId]);

      const overallStats = userOverallStats[0] || {};
      overallStats.overall_accuracy = overallStats.total_questions_attempted > 0
        ? Math.round((overallStats.total_correct / overallStats.total_questions_attempted) * 100)
        : 0;

      res.status(200).json({ 
        success: true, 
        assignments,
        overallStats
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

exports.getAllRegularUsers = async (req, res) => {
  try {
    // Get all users who are not admins
    const [users] = await pool.query(`
      SELECT 
        id,
        email,
        created_at,
        (SELECT COUNT(*) FROM user_responses WHERE user_id = users.id) as total_questions_attempted,
        (SELECT COUNT(DISTINCT assignment_id) FROM user_responses WHERE user_id = users.id) as total_assignments_attempted
      FROM users
      WHERE is_admin = false
      ORDER BY created_at DESC
    `);

    res.status(200).json({ 
      success: true, 
      users,
      count: users.length
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};

exports.getQuestionMastery = async (req, res) => {
  try {
    const { userId, questionId } = req.params;
    const [mastery] = await pool.query(
      'SELECT status, COUNT(*) as attempt_count FROM user_responses WHERE user_id = ? AND question_id = ? GROUP BY status',
      [userId, questionId]
    );

    res.status(200).json({ success: true, mastery });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAllCategories = async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM categories');
    res.status(200).json({ success: true, categories });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getCategoryQuestions = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const [questions] = await pool.query('SELECT * FROM questions WHERE category_id = ?', [categoryId]);
    res.status(200).json({ success: true, questions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAssignmentDetails = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const conn = await pool.getConnection();
    
    try {
      // Get assignment basic info
      const [assignments] = await conn.query(
        'SELECT * FROM test_assignments WHERE id = ?',
        [assignmentId]
      );
      
      if (assignments.length === 0) {
        return res.status(404).json({ success: false, error: 'Assignment not found' });
      }

      // Get categories and questions
      const [categories] = await conn.query(`
        SELECT 
          ac.category_id, 
          c.name as category_name,
          ac.question_count
        FROM assignment_categories ac
        JOIN categories c ON ac.category_id = c.id
        WHERE ac.assignment_id = ?
      `, [assignmentId]);

      for (const category of categories) {
        const [questions] = await conn.query(
          'SELECT id, question, options, correct_answer FROM questions WHERE category_id = ? LIMIT ?',
          [category.category_id, category.question_count]
        );
        category.questions = questions.map(q => ({
          ...q,
          options: JSON.parse(q.options)
        }));
      }

      res.status(200).json({
        success: true,
        assignment: {
          ...assignments[0],
          categories
        }
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
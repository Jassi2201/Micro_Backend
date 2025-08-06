const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Auth routes
router.post('/register', userController.register);
router.post('/login', userController.login);

// Assignment routes
router.get('/:userId/assignments', userController.getAssignments);
router.get('/:userId/assignments/:assignmentId/questions', userController.getAssignmentQuestions);



// Progress routes
router.get('/:userId/progress', userController.getUserProgress);


router.post('/:userId/assignments/:assignmentId/submit', userController.submitAssignment);

router.get('/:userId/assignments/:assignmentId/results', userController.getAssignmentResults);
// Add this to your routes file
router.get('/:userId/assignments/completion-details', userController.getUserAssignmentCompletionDetails);



module.exports = router;
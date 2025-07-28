const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Category routes
router.post('/categories', adminController.addCategory);
router.get('/categories', adminController.getAllCategories);
router.get('/categories/:categoryId/questions', adminController.getCategoryQuestions);

// Question routes
router.post('/questions', adminController.uploadMiddleware(), adminController.addQuestion);
router.post('/questions/bulk', adminController.bulkAddQuestions);

// Test Assignment routes
router.post('/assignments', adminController.createTestAssignment);

// User progress routes
router.get('/users/:userId/history', adminController.getUserHistoryForAdmin);
router.get('/users/:userId/questions/:questionId/mastery', adminController.getQuestionMastery);
router.get('/assignments/:assignmentId', adminController.getAssignmentDetails);
router.get('/assignments',adminController.getAllAssignments)
router.get(`/getAllRegularUsers`,adminController.getAllRegularUsers)

module.exports = router;
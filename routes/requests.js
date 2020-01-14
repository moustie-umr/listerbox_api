const express = require('express');
const {
  addRequest,
  getRequests,
  getRequest,
  updateRequest,
  deleteRequest,
  acceptRequest,
  rejectRequest,
  completeRequest
} = require('../controllers/requests');

const Request = require('../models/Request');

const router = express.Router({ mergeParams: true });

const advancedResults = require('../middleware/advancedResults');
const { protect, authorize } = require('../middleware/auth');

router
  .route('/')
  .post(protect, authorize('User', 'Admin'), addRequest)
  .get(
    protect,
    authorize('User', 'Admin'),
    advancedResults(Request, { path: 'task', select: 'title' }),
    getRequests
  );

router
  .route('/:id')
  .get(protect, authorize('User', 'Admin'), getRequest)
  .put(protect, authorize('User', 'Admin'), updateRequest)
  .delete(protect, authorize('Admin'), deleteRequest);

router
  .route('/acceptrequest/:id')
  .put(protect, authorize('Tasker', 'Admin'), acceptRequest);

router
  .route('/completerequest/:id')
  .put(protect, authorize('Tasker', 'Admin'), completeRequest);

router
  .route('/rejectrequest/:id')
  .put(protect, authorize('Tasker', 'Admin'), rejectRequest);

module.exports = router;
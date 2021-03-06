const https = require('https');
const paystack = require('paystack')(process.env.SECRET_KEY);

const ErrorResponse = require('../utils/errorResponse');
const asyncHandler = require('../middleware/async');
const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const Earning = require('../models/Earning');
const Task = require('../models/Task');
const User = require('../models/User');
const Profile = require('../models/Profile');
const sendEmail = require('../utils/sendEmail');

// @desc    Get all customers
// @route   GET /api/v1/payements/customers
// @access  Private/Admin
exports.getCustomers = asyncHandler(async (req, res, next) => {
  paystack.customer
    .list()
    .then(body => {
      res.status(200).json(body);
    })
    .catch(err => {
      res.status(404).json(err);
    });
});

// @desc    Initializing payment
// @route   GET /api/v1/payements/initialize
// @access  Private/Admin
exports.initializePayment = asyncHandler(async (req, res, next) => {
  let taskID = req.params.taskID;
  taskID = taskID.trim();
  if (taskID == '') {
    return next(new ErrorResponse(`Please enter a task ID`, 400));
  }
  let task = await Task.findById(taskID, (err, task) => {
    if (err) {
      return next(
        new ErrorResponse(`No task with the id of ${req.params.taskID}`, 404)
      );
    }
    return task;
  });

  let user = await User.findById(task.user, (err, user) => {
    if (err) {
      res.status(404).json({ status: 'failed', message: err.message });
      return;
    }
    return user;
  });

  // add checks here is transaction already proccessed

  var options = {
    host: process.env.PAYMENT_HOST,
    path: `/transaction/initialize/`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  let referenceID =
    Math.random()
      .toString(36)
      .substring(2, 15) +
    Math.random()
      .toString(36)
      .substring(2, 15);
  var paymentData = JSON.stringify({
    reference: referenceID, // generate your transaction id
    amount: task.price * 100,
    email: req.user.email,
    callback_url: `${req.protocol}://${req.get(
      'host'
    )}/api/v1/payments/verify/${referenceID}` // paste here web url which will call api url of success
  });

  let data = '';
  var paymentreq = https.request(options, paymentRes => {
    paymentRes.on('data', chunk => {
      data += chunk;
    });
    paymentRes.on('end', async () => {
      data = JSON.parse(data);
      if (data['status']) {
        // pay %85 to the tasker and %15 for Listerbox
        const netAmount = (85 / 100) * task.price;

        let paymentdetails = {
          user: req.user.id,
          task: task['_id'],
          amount: netAmount,
          taskOwner: user,
          referenceID: referenceID,
          accessCode: data['data']['access_code'],
          status: 'Init'
        };

        await Payment.create(paymentdetails, (e, p) => {
          if (e) {
            res.status(500).json({
              status: 'failed',
              message: 'Error while inserting payment details!'
            });
          }
        });

        let responseData = {
          payment_url: data['data']['authorization_url'],
          reference_id: referenceID
        };
        res.status(200).json({ status: 'success', data: responseData });
      } else {
        res.status(400).json({ status: 'failed', message: data['message'] });
      }
      return;
    });
  });

  paymentreq.on('error', e => {
    res.json(e);
    return;
    // console.error(`problem with request: ${e.message}`);
  });

  // Write data to request body
  paymentreq.write(paymentData);
  paymentreq.end();
});

exports.verifyPayment = asyncHandler(async (req, res, next) => {
  let referenceID = req.params.referenceID;
  referenceID = referenceID.trim();
  if (referenceID == '') {
    res
      .status(400)
      .json({ status: 'failed', message: 'please enter valid reference id!' });
    return;
  }
  let paymentData = await Payment.findOne(
    { referenceID: referenceID },
    (err, paymenData) => {
      if (err) {
        res.status(404).json({ status: 'failed', message: err.message });
        return;
      }
      return paymenData;
    }
  );
  if (paymentData['status'][0] === 'Paid') {
    res.status(200).json({ status: 'success', data: paymentData });
    return;
  }

  // calls to verify trasaction
  let options = {
    hostname: process.env.PAYMENT_HOST,
    path: `/transaction/verify/${paymentData['referenceID']}`,
    headers: {
      Authorization: `Bearer ${process.env.SECRET_KEY}`
    }
  };
  https
    .get(options, resp => {
      let data = '';
      resp.on('data', chunk => {
        data += chunk;
      });

      resp.on('end', async () => {
        verifiedData = JSON.parse(data);
        if (
          verifiedData['status'] &&
          verifiedData['data']['status'] === 'success'
        ) {
          paymentData = await Payment.findOneAndUpdate(
            { referenceID: paymentData['referenceID'] },
            { status: 'Paid', paidAt: verifiedData['data']['paid_at'] },
            (e, pd) => {
              if (e) {
                // create log in db of failed updations
                res.status(404).json({
                  status: 'failed',
                  message: 'Unable to update payment status'
                });
              }
              return pd;
            }
          );
          res.status(200).json({ status: 'success', data: paymentData });

          // Get task details for a particular tasker
          let taskerDetails = await Task.find({ _id: paymentData.task });

          let earning = await Earning.find({
            taskOwner: taskerDetails[0].user
          });

          const transactions = await Payment.find({
            taskOwner: paymentData.taskOwner,
            status: 'Paid'
          });

          // Calculate all transactons for Taskers to get net earning

          const getEarning = transactions.map(amt => amt.amount);
          const getNetEarning = getEarning.reduce(
            (partial_sum, a) => partial_sum + a,
            0
          );
          const NetEarning = getNetEarning;

          // Save payments to earnings collection
          req.body.taskOwner = taskerDetails[0].user;
          req.body.taskId = taskerDetails[0]._id;
          req.body.payment = paymentData._id;
          req.body.netEarning = NetEarning;
          req.body.availableForWithdrawal = NetEarning;

          if (earning.length == 0) {
            await Earning.create(req.body);
            console.log(req.body);
          } else {
            // Update the earning collection
            console.log('Earnings Available');
          }

          // Send email to tasker after user pays for a service successfully
          // const profile = await Profile.findById({ _id: task.profile });
          let taskerUser = taskerDetails[0].user;

          // Get user details for a particular tasker
          let taskerUserDetails = await User.find({ _id: taskerUser });

          const message = `Hi ${taskerUserDetails[0].name}, you just got an offer on your service '${taskerDetails[0].title}'. Please login to your dashboard to get your task started`;

          await sendEmail({
            email: taskerUserDetails[0].email,
            subject: 'Task Request',
            message
          });
        } else {
          res
            .status(404)
            .json({ status: 'failed', message: verifiedData['message'] });
        }

        return;
      });
    })
    .on('error', err => {
      res.status(400).json({ status: 'failed', message: err.message });
      return;
    });
});

// @desc    Get a particular transaction by referenceID
// @route   GET /api/v1/payements/reference/:taskID
// @access  Private/Admin
exports.getTransactionReference = asyncHandler(async (req, res, next) => {
  const reference = await Payment.find({ referenceID: req.params.referenceID });

  if (!reference) {
    return next(
      new ErrorResponse(
        `No payment found with reference id of ${req.params.id}`
      ),
      404
    );
  }

  res.status(200).json({
    success: true,
    data: reference
  });
});

// @desc    Get all approved transactions for a particular task
// @route   GET /api/v1/payements/transaction/:taskID
// @access  Private/Admin
exports.getTransaction = asyncHandler(async (req, res, next) => {
  let taskID = req.params.taskID;
  taskID = taskID.trim();
  if (taskID == '') {
    res
      .status(400)
      .json({ status: 'failed', message: 'please enter valid task id!' });
  }
  let paymentData = await Payment.find(
    { task: taskID, status: 'Paid' },
    (err, paymenData) => {
      if (err) {
        res.status(404).json({ status: 'failed', message: err.message });
      }
      return paymenData;
    }
  );

  res.status(200).json({
    success: true,
    data: paymentData
  });
});

// @desc    Get all approved transactions for a particular tasker by userId
// @route   GET /api/v1/payements/transaction/taskeruser/:userId
// @access  Private/Tasker
exports.getTransactionForTaskerByUserId = asyncHandler(
  async (req, res, next) => {
    const transactions = await Payment.find({
      taskOwner: req.params.userId,
      status: 'Paid'
    });

    if (transactions.length < 1) {
      return next(
        new ErrorResponse(
          `No paid transactions available for user id ${req.params.userId}`
        ),
        404
      );
    }

    const earnings = transactions.map(amt => amt.amount);

    const netEarning = earnings.reduce((partial_sum, a) => partial_sum + a, 0);

    res.status(200).json({
      success: true,
      earnings: netEarning,
      data: transactions
    });
  }
);

// @desc    Get all approved transactions for a particular tasker by taskID
// @route   GET /api/v1/payements/transaction/tasker/:taskID
// @access  Private/Tasker
exports.getTransactionForTasker = asyncHandler(async (req, res, next) => {
  let taskID = req.params.taskID;
  taskID = taskID.trim();
  if (taskID == '') {
    return next(new ErrorResponse(`Please enter valid task id`, 400));
  }

  // Find all paid tasks
  let userTrans = await Payment.find({
    task: req.params.taskID,
    status: 'Paid',
    taskOwner: req.user.id
  });

  if (!userTrans || userTrans.length < 1) {
    return next(new ErrorResponse(`Not authorized to view transactions`, 401));
  }

  res.status(200).json({
    success: true,
    data: userTrans
  });
});

// @desc    Request for a payout by the Tasker
// @route   GET /api/v1/payements/transaction/payout/:taskID
// @access  Private/Tasker
exports.requestPayout = asyncHandler(async (req, res, next) => {});

const express = require('express');
const l2norm = require( 'compute-l2norm' );
const bodyParser = require('body-parser');
const Cloudant = require('@cloudant/cloudant');
const cfenv = require('cfenv');
const fileType = require('file-type');
const fs = require('fs');

const app = express();
const server = app.listen(3000);

// Here we are configuring express to use body-parser as middle-ware.
// This is so we can handle POST requests. 
app.use(bodyParser.urlencoded({ extended: false }));

// If you wish to upload larger images to the backend then adjust the limit below
// However, be aware that the Cloudant database will only accept a certain size of 
// request.
app.use(bodyParser.json({limit: '10mb'}));

// Serving static files from the public directory
app.use(express.static('public'));

// Loading local VCAP parameters to allow connection to Cloudant database
var vcapLocal;
try {
  vcapLocal = require('./vcap-local.json');
  console.log('Loaded local VCAP credentials!');
} catch (e) {}

const appEnvOpts = vcapLocal ? {vcap: vcapLocal} : {}
const appEnv = cfenv.getAppEnv(appEnvOpts);

// Connect to our Cloudant instance using the local credentials
// To use env variables (i.e. app is deployed into the cloud) see below:
// https://github.com/IBM-Cloud/get-started-node/blob/master/server.js
cloudant = Cloudant(appEnv.services['cloudantNoSQLDB'][0].credentials);

// Connect to the database we will use.
pro_golfers_db = cloudant.db.use('pro_golfers')

// poseVector1 and poseVector2 are 52-float vectors composed of:
// Values 0-33: are x,y coordinates for 17 body parts in alphabetical order
// Values 34-50: are confidence values for each of the 17 body parts in alphabetical order
// Value 51: A sum of all the confidence values
// Again the lower the number, the closer the distance
function weightedDistanceMatching(poseVector1, poseVector2) {
  let vector1PoseXY = poseVector1.slice(0, 34);
  let vector1Confidences = poseVector1.slice(34, 51);
  let vector1ConfidenceSum = poseVector1.slice(51, 52);

  let vector2PoseXY = poseVector2.slice(0, 34);

  // First summation
  let summation1 = 1 / vector1ConfidenceSum;

  // Second summation
  let summation2 = 0;
  for (let i = 0; i < vector1PoseXY.length; i++) {
    let tempConf = Math.floor(i / 2);
    let tempSum = vector1Confidences[tempConf] * Math.abs(vector1PoseXY[i] - vector2PoseXY[i]);
    summation2 = summation2 + tempSum;
  }

  return summation1 * summation2;
}

function minValueFromResults(results_array, min_value) {
  for (var entry in results_array) {
    if (results_array[entry]['Score'] === min_value) {
      matching_name = results_array[entry];
      return matching_name;
    }
  }
}

function formatPoseArray(keypoints) {
  let point;
  let xy_array = [];
  let confidence_array = [];

  let norm;
  let norm_xy_array;

  for (point in keypoints) {
    x_position = keypoints[point]['position']['x'];
    y_position = keypoints[point]['position']['y'];

    xy_array.push(x_position);
    xy_array.push(y_position);

    single_confidence = keypoints[point]['score'];
    confidence_array.push(single_confidence);
  };

  // Normalising the xy keypoint array using the L2 (euclidean) norm
  norm = l2norm(xy_array);
  norm_xy_array = xy_array.map(function(element) {
    return element/norm;
  });

  confidence_sum = confidence_array.reduce((a, b) => a + b, 0);
  confidence_array.push(confidence_sum);

  new_array = norm_xy_array.concat(confidence_array);

  return new_array;
}


app.post('/poses', (req, res) => {
  let new_array;

  let results_array = [];
  let scores_array = [];
  let doc_array = [];
  let matching_name = '';
  let successful_response;

  keypoints = req.body[0]['pose']['keypoints']
  new_array = formatPoseArray(keypoints);

  pro_golfers_db.list({ include_docs: true }, function(err, body) {
    if (!err) {
      body.rows.forEach(function(doc) {
        doc_array = doc['doc']['array'];

        compared_score = weightedDistanceMatching(new_array, doc_array);
  
        results_array.push({
          'id': doc['id'],
          'Score': compared_score,
          'Name': doc['doc']['name']
          });
  
        scores_array.push(compared_score);
        });
      }

      const min_value = Math.min.apply(Math, scores_array);
      matching_name = minValueFromResults(results_array, min_value);

      pro_golfers_db.attachment.get('tiger_woods_backswing', 'tiger_woods_backswing' + '_image', function(err, body) {
        if (!err) {
          console.log(body);
          successful_response = [matching_name, body.toString('base64')];
          res.send(successful_response);
        } else {
          console.log(err);
        }
      });
    });
});


app.post('/upload_image', (req, res) => {
  const id = req.body['_id'];
  const name = req.body['name'];
  const pose = req.body['pose'];
  const keypoints = req.body['array'][0]['pose']['keypoints'];
  const imgData = req.body['imgData'];

  // Must replace the meta data included at the start of the base64 string by the browser
  // This is not used by node, and therefore causes it to corrupt the image.
  const strippedImgData = imgData.replace(/^data:image\/(png|gif|jpeg);base64,/,'');
  
  // Getting the pose classification into the correct format.
  let newArray = formatPoseArray(keypoints);
  
  // Converting our base64 encoded data to buffer- the datatype Cloudant uses
  // as well as the other open source DB implementations (couchDB etc.) 
  var bufferImgData = Buffer.from(strippedImgData, 'base64');

  newDocument = {'_id': id,
                 'name': name,
                 'pose': pose,
                 'array': newArray}

  pro_golfers_db.insert(newDocument, function(err, body, header) {
    if (err) {
      console.log('[pro_golfers_db.insert]', err.message);
      res.send('Error');
      return;
    }
    res.send(newDocument);
    addAttachment();
  });

  function addAttachment() {
    pro_golfers_db.get(id).then((body) => {
      let revID = body['_rev'];
      pro_golfers_db.attachment.insert(id, id + '_image', bufferImgData, "image/png", 
      { rev: revID }, function(err, body) {
        if (!err) {
          console.log(body);
        } else {
          console.log(err);
        }
      }); 
    });
  };
});
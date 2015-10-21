var _ = require('underscore');
var bodyParser = require('body-parser');
var express = require('express');
var mongoose = require('mongoose');

var app = express();

mongoose.connect('mongodb://localhost/badchat');
var db = mongoose.connection;

var Chatroom;

/* conns polling each room */
var waitingConns = {};

/* parse POST body */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);

/* public dir is static */
app.use(express.static('public'));

/* close long polling connections older than 30 seconds */
var clearConnections = function() {
  var timeoutThreshold = new Date();
  timeoutThreshold.setSeconds(timeoutThreshold.getSeconds() - 30);
  Object.keys(waitingConns).forEach(function (key) {
    var conns = waitingConns[key];
    for(var i = conns.length - 1; i >= 0; i--)
      if(conns[i].date < timeoutThreshold) {
        console.log("Closing polling connection");
        conns[i].out.json([]);
        conns.splice(i, 1);
      }
  });
};

/* get room from db and return via a promise */
var getRoom = function(roomid) {
  return new Promise(function(fulfill, reject) {
    Chatroom.findById(roomid).exec(function(err, data) {
    if (err)
      reject(err);
    else if (!data)
      reject("Room not found");
    else
      fulfill(data);
    });
  });
};

/* show main page */
app.get('/', function (req, res) {
  res.render('index');
});

/* find rooms created after [param] */
app.get('/getrooms/*?', function(req, res) {
  var query = (req.params[0]) ? {date: {$gt: req.params[0]}} : {};
  Chatroom.find(query).sort( {date: -1} ).then(function(data) {
    var roominfo = _.map(data, function(chat) {
      return {
        name: chat.name,
        id: chat._id,
        date: chat.date.getTime()
      };
    });
    res.json( {rooms: roominfo} );
  }).catch(function(err) {
    res.json( {error: err} );
  });
});

/* create new room */
app.post('/newroom', function(req, res) {
   if (req.body.name) {
     var newchat = new Chatroom({
       name: req.body.name,
       date: Date.now()
     });
     newchat.save();
     res.json( {id: newchat._id} );
     console.log("New room: " + newchat.name);
  } else {
     res.json( {error: 'Empty name'} );
  }
});

/* get messages from [room] after [timestamp] */
app.get('/room/:room/getafter/:timestamp', function(req, res) {
  Chatroom.find({
    _id: req.params.room,
    msg: {
      $elemMatch: {
        date: { $gt: req.params.timestamp }
      }
    }
  }).then(function (result) {
    /* if no new messages exist add stream to the queue (long polling) */
    if (result.length == 0) {
      waitingConns[req.params.room] = waitingConns[req.params.room] || [];
      waitingConns[req.params.room].push({ out: res, date: new Date() });
    } else {
      res.json(result[0].msg);
    }
  });
});

/* send a new message to [room] */
app.post('/room/:room/send', function(req, res) {
  var body = req.body, room = req.params.room;
  if (body.user && body.text) {
    getRoom(room).then(function (data) {
      /* add the message and save */
      var newmsg = {
        user: body.user,
        text: body.text,
        date: new Date()
      };
      data.msg.push(newmsg);
      data.save();
      
      /* notify users polling the room */
      if (waitingConns[room]) {
        var pending = waitingConns[room];
        waitingConns[room] = [];
        pending.forEach(function (res) {
          res.out.json( [newmsg] );
        });
      }
      
      res.end();
    }).catch(function (err) {
      res.json({error: err.toString()});
    });
  } else
    res.end();
});

/* on successful db connection start server */
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function (callback) {
  console.log("MongoDB connection opened");
  Chatroom = mongoose.model('chatroom', mongoose.Schema({
    name: String,
    date: Date,
    msg: [{
      user: String,
      text: String,
      date: Date
    }]
  }));
    
  var server = app.listen(process.env.PORT, process.env.IP, 100, function() {
    var host = server.address().address;
    var port = server.address().port;

    console.log('Listening at http://%s:%s', host, port);
  });
  
  setInterval(clearConnections, 5000);
});
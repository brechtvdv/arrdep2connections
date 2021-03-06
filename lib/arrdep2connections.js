var Transform = require('stream').Transform,
    util = require('util'),
    moment = require('moment'),
    fs = require('fs'),
    StreamIterator = require('./StreamIterator.js');

util.inherits(ArrDep2Connections, Transform);

function ArrDep2Connections (arrivalsStream, options) {
  Transform.call(this, {objectMode : true});
  this._arrivalsIterator = new StreamIterator(arrivalsStream);
  //This should be changed by a way to get the next ones at a certain stop?
  this._arrivalsQueue = []; //chronologically sorted list of arrivals
  this._arrivalsQueueIndex = 0;
  this._departuresContext = {"@context" : {}};

  //This is a jsonldstream as well and has a this["@context"]
  var context = JSON.parse(fs.readFileSync(options.outbound, 'utf8'));
  this.push(context);
}

ArrDep2Connections.prototype._flush = function (done) {
  //Try to match the remainder of the departure/arrival pairs
  //console.log(this._arrivalsQueue);
 done();
};

ArrDep2Connections.prototype._transform = function (departure, encoding, done) {
  if (departure["@context"]) {
    this._departuresContext = departure["@context"];
    done();
  } else {
    departure["departureTime"] =  new Date(this._normalizeISO8601(departure["date"] + 'T' + departure["departureTime"]));
    var self = this;
    this._arrivalsQueueIndex = 0;
    this._arrivalTimeOffsetKey = 'minutes';
    this._arrivalTimeOffsetUnits = 240; // amount of time that arrivals are possible after a departure
    this._maxArrivalTime = null; // holds maximum arrivalTime that is possible for a departure
    this._getNextArrival(function (arrival) {
      if (arrival) {
        var processNextArrival = function () {
          self._getNextArrival(function (nextArrival) {
            if (nextArrival) {
              if (self._maxArrivalTime != null) {
                // Is arrival still possible
                if (nextArrival["arrivalTime"].getTime() <= self._maxArrivalTime.getTime()) {
                  setImmediate(function () {
                    self._processArrival(departure, nextArrival, processNextArrival, done);
                  });
                } else {
                  // No possible arrival found
                  this._arrivalsQueueIndex = 0; // Turn back index to process arrivals again for next departure
                  this._maxArrivalTime = null; // reset
                  done(); // next departure
                }
              } else if (departure["stopSequence"] != departure["maxStopSequence"]) {
                setImmediate(function () {
                  self._processArrival(departure, nextArrival, processNextArrival, done);
                });
              } else {
                this._arrivalsQueueIndex = 0; // Turn back index to process arrivals again for next departure
                this._maxArrivalTime = null; // reset
                done(); // next departure
              }
            } else {
              // console.error("no next arrival");
              done();
            }
          });
        };
        // Is stopSequence feature available to know if end of trip is reached?
        if (typeof departure["stopSequence"] === "undefined" || typeof departure["maxStopSequence"] === "undefined") {
          // Use time offset of arrivalTimes that are possible
          this._maxArrivalTime = moment(departure["departureTime"]).add(self._arrivalTimeOffsetUnits, self._arrivalTimeOffsetKey).toDate();
        } else {
          this._maxArrivalTime = null;
        }

        //we can call nextArrival if no connections have been found, or done when a connection has been found
        self._processArrival(departure, arrival, processNextArrival, done);
      } else {
        // console.error("No beginning arrival found...");
        done();
      }
    });
  }
}

ArrDep2Connections.prototype._createConnection = function (arrival, departure) {
  var connection = {};
  connection["@type"] = "Connection";
  connection["arrivalTime"] = arrival["arrivalTime"];
  connection["arrivalStop"] = arrival["stop"];
  connection["departureTime"] = departure["departureTime"];
  connection["departureStop"] = departure["stop"];
  connection["trip"] = departure["trip"];
  if (departure["headsign"] || arrival["headsign"]) 
    connection["headsign"] = departure["headsign"] || arrival["headsign"];
  connection["route"] = departure["route"];
  //TODO: extend with other...
  return connection;
};

/**
 * Normalizes an ISO string to always use dashes, colons and a period instead of a comma
 */
ArrDep2Connections.prototype._normalizeISO8601 = function (str) {
  return str
    //if a ss,SSSS is detected, turn it into ss.SSSS
    .replace(/(\d{2}),(\d\d?\d?\d?)/,"$1.$2")
    //if a YYYYYYMMDD is detected, add dashes
    .replace(/^(\s*)([+-]\d{6})(\d{2})(\d{2})/,"$1$2-$3-$4")
    //if a YYYYMMDD is detected, add dashes
    .replace(/^(\s*)(\d{4})(\d{2})(\d{2})/,"$1$2-$3-$4")
    //if a GGGG[W]WWE is detected, add dashes
    .replace(/^(\s*)(\d{4})W(\d{2})(\d{1})/,"$1$2-W$3-$4")
    //if a GGGG[W]WW is detected, add dashes
    .replace(/^(\s*)(\d{4})W(\d{2})/,"$1$2-W$3")
    //if a YYYYDDD is detected, add dashes
    .replace(/^(\s*)(\d{4})(\d{3})/,"$1$2-$3")
    //if a HHmmss is detected, add colons
    .replace(/(T| )(\d{2})(\d{2})(\d{2})/,"$1$2:$3:$4")
    //if a HHmm is detected, add colons
    .replace(/(T| )(\d{2})(\d{2})/,"$1$2:$3")
    //if a timezone is detected without a colon, add a colon
    .replace(/(?!^\s*)([+-])([0-1][0-9])(\d{2})/,"$1$2:$3");
};

ArrDep2Connections.prototype._getNextArrival = function (cb) {
  //TODO: make sure the context of the arrival is taken into account
  var arrivalQueueItem = this._arrivalsQueue[this._arrivalsQueueIndex];
  var self = this;
  if (arrivalQueueItem) {
    this._arrivalsQueueIndex++;
    cb(arrivalQueueItem);
  } else {
    this._arrivalsIterator.next(function (arrival) {
      if (arrival) {
        arrival["arrivalTime"] = new Date(self._normalizeISO8601(arrival["date"] + 'T' + arrival["arrivalTime"]));
        self._arrivalsQueue.push(arrival);
        cb(arrival);
      } else if (self._arrivalsQueue.length > 0) {
        // Only possible when stopSequence feature is not available
        // and there are connections with the same departure- and arrivalTime
        self._arrivalsQueueIndex = 0;
        cb(null); // No next arrival, so drop departure
      } else {
        cb();
        self.end(null,null, function () {
         //console.error("finished");
        });
      }
    });
  }
}

ArrDep2Connections.prototype._processArrival = function (departure, arrival, next, done) {
  console.error(arrival);
  if (arrival) {
    //check if arrival has the same trip id, if it does, we've got a winner: first thing always wins
    var departureTime = departure["departureTime"]; // e.g.: Date object 2015-09-09T00:01
    var arrivalTime = arrival["arrivalTime"];
    var departureDateTime = new Date(departureTime);
    var arrivalDateTime = new Date(arrivalTime);
  
    // Connections with equal arrival- and departuretimes are possible (e.g. De Lijn)
    // Keep those to stay consistent with stops
    if (arrivalDateTime < departureDateTime) {
      //discart it (as this is only possible for the first X items, we can do shift and bring the arrivalsQueueIndex back to 0
      for (var i = 0; i < this._arrivalsQueueIndex; i++) {
        this._arrivalsQueue.shift();
      }
      this._arrivalsQueueIndex = 0;
      next();
    } else if (departure["trip"] === arrival["trip"]) {
      // If feature with stopSequence is available, we can make connections with departureTime equal to arrivalTime
      if (departure['stopSequence'] && arrival['stopSequence'] && (departure['stopSequence'] == (arrival['stopSequence'] - 1))) {
        var connection = this._createConnection(arrival, departure);
        this._arrivalsQueueIndex = 0;
        this.push(connection);
        done();
      } else if (departureTime < arrivalTime) {
        // first one to encounter each other: it's a match!
        var connection = this._createConnection(arrival, departure);
        this._arrivalsQueueIndex = 0;
        this.push(connection);
        done();
      } else {
        // arrival is part of previous connection or feature stopSequence is not available
        next();
      }
    } else {
      // Set maximum arrivalTime of connection, so no all arrivals have to be checked. (prevent memory issues)
      if (!this._maxArrivalTime) {
        this._maxArrivalTime = moment(departure["departureTime"]).add(this._arrivalTimeOffsetUnits, this._arrivalTimeOffsetKey).toDate();
      }

      if (arrival["arrivalTime"].getTime() <= this._maxArrivalTime.getTime()) {
        //arrival is part of the next one part of another trip.
        next();
      } else {
        done();
      }
    }
  } else {
    debugger;
    // No matching arrival found
    done();
  }
}

module.exports = ArrDep2Connections;

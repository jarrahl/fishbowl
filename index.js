const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

var fs = require('fs');
var http = require('http').createServer(app);
var io = require('socket.io')(http);

const PORT = 3000;

var cardRepository = [];

info_file = fs.createWriteStream("log_info", {flags: 'a'});
error_file = fs.createWriteStream("log_error", {flags: 'a'});
function logString(msg) {
  let d = new Date();
  return d.toISOString() + ": " + msg;
}
function logInfo() {
  let s = logString(Array.from(arguments).join(", "));
  info_file.write(s +"\n");
  console.log(s);
}
function logError() {
  let s = logString("[ERROR] " + Array.from(arguments).join(", "));
  error_file.write(s + "\n");
  console.log(s);
}

fs.readFile('cards.txt', 'utf8', function(err, file) {
  file.split('\n').forEach((line) => {
    if (line.length > 0 && line.charAt(0) != '#') {
      cardRepository.push(line);
    }
  });
  logInfo("Read " + cardRepository.length + " cards into repository.");
});

function rand(n) {
  return Math.floor(Math.random() * n);
}
function randElement(arr) {
  return arr[rand(arr.length)];
}
function selectNCards(n) {
  let cards = [];
  for (let i = 0; i < n; i++) {
    do {
      var card = randElement(cardRepository);
    } while (cards.includes(card));
    cards.push(card);
  }
  return cards;
}
function tryMoveElement(src, dst, x) {
  if (src.indexOf(x) >= 0) {
    dst.push(src.splice(src.indexOf(x), 1)[0]);
    return true;
  }
  return false;
}

var rooms = {};
const ROOM_ID_LENGTH = 4;
const TURN_TIME_SECONDS = 30; // Doubled for round 3.
const TIMER_BUFFER = 500; // half a second for network lag.
const CARDS_PER_PLAYER = 5;
const TURN_COUNTDOWN = 3; // Turn starting in 3..2...1..
const MIN_TIME_ROLLOVER = 5; // start the next round if you have 5s on the clock.
const BAD_ROOM_IDS = ['ANAL', 'ANUS', 'ARSE', 'CLIT', 'COCK', 'CRAP', 'CUNT', 
  'DICK', 'DYKE', 'FUCK', 'GOOK', 'HOMO', 'JERK', 'KIKE', 'PAKI', 'PISS',
  'SHAG', 'SHIT', 'SLAG', 'SLUT', 'SPIC', 'SUCK', 'TURD', 'TWAT', 'WANK'];

function createRoom() {
  let id = "";
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    id += String.fromCharCode(rand(26) + 65);
  }
  if (id in rooms || BAD_ROOM_IDS.includes(id)) return createRoom();
  rooms[id] = {id: id,
               curPlayer: -1,
               players: [],
               teams: [{}, {name: 'Red', score: 0},
                           {name: 'Blue', score: 0}],
               bowlCards: [],
               discards: [],
               gotCards: [],
               prevPlayer: null,
               stage: 'pregame',
               paused: false,
               cardTimes: {}};
  return id;
}

function autoPickTeam(players) {
  teamSize = [0, 0, 0];
  for (let player of players) {
    teamSize[player.team] = (teamSize[player.team] || 0) + 1;
  }
  // TODO: allow more than 2 teams
  return (teamSize[1] <= teamSize[2]) ? 1 : 2;
}

function sendNewCard(room) {
  if (room.bowlCards.length == 0) {
    logError(room.id + " trying to send new card with empty bowl");
    return;
  }
  room.curCard = room.bowlCards.splice(rand(room.bowlCards.length), 1)[0];
  room.lastNewCardTime = Date.now();
  io.to(room.players[room.curPlayer].socket_id).emit('turn_state', {curCard: room.curCard});
}

function pointsForStage(stage) {
  if (stage == "round1") return 1;
  if (stage == "round2") return 2;
  if (stage == "round3") return 3;
  return 0;
}

io.on('connection', function(socket) {
  let ip = socket.handshake.headers["x-real-ip"];
  let player = {};
  let player_index = -1;
  let room = {};
  // Fresh connection = assume new player. They first need to send us
  // a name and room code to join. Empty room code = create room.

  // Call updateRoom('players', 'cards') to send just players, cards fields of
  // room to clients.
  function updateRoom() {
    let delta = {};
    let turn_state_delta = {};
    for (let i = 0; i < arguments.length; i++) {
      let val = null;
      if (arguments[i] == 'numDiscards') val = room.discards.length;
      else if (arguments[i] == 'numCardsLeft') val = room.bowlCards.length;
      else if (arguments[i] == 'discards' || arguments[i] == 'curCard') {
        turn_state_delta[arguments[i]] = room[arguments[i]];
      } else {
        val = room[arguments[i]];
      }
      if (val !== undefined && val !== null) delta[arguments[i]] = val;
    }
    if (Object.keys(delta).length) {
      io.in(room.id).emit('room_state', delta);
    }
    if (Object.keys(turn_state_delta).length && room.curPlayer >= 0) {
      io.to(room.players[room.curPlayer].socket_id).emit('turn_state', turn_state_delta);
    }
  }

  function startCountdown(name, time, callback) {
    room[name] = time;
    updateRoom(name);
    room['_interval_' + name] = setInterval(function() {
      if (!room.paused) {
        room[name] -= 1;
        updateRoom(name);
        if (room[name] == 0) {
          clearInterval(room['_interval_' + name]);
          room['_interval_' + name] = null;
          callback();
        }
      }
    }, 1000);
  }

  // join_room(name, room_id)
  // emits room_state to socket
  socket.on('join_room', function(msg) {
    if (!msg.name) {
      socket.emit('join_room_error', 'name must not be empty!');
      return;
    }
    room_id = (msg.room_id || createRoom()).toUpperCase().trim();
    if (!rooms[room_id]) {
      socket.emit('join_room_error', 'Room "' + room_id + '" does not exist');
      logInfo(ip, msg.name + " tried to join non-existent room " + room_id);
      return;
    }
    room = rooms[room_id];
    // try find existing player with this name.
    player = room.players.find(x => x.name == msg.name);
    if (player == undefined) {
      if (room.stage != 'pregame') {
        socket.emit('join_room_error', 'Can not join started game as new player.');
        return;
      }
      player = {name: msg.name,
                team: autoPickTeam(room.players),
                last_played: 0,
                gotCards: [],
                isAdmin: room.players.length == 0};
      logInfo(ip, msg.name + " (" + room.players.length + ") joined room " + room_id);
      room.players.push(player);
    } else {
      logInfo(ip, msg.name + " re-connected to room " + room_id);
    }
    player_index = room.players.indexOf(player);
    player.socket_id = socket.id;
    // update others, connect player to room, send room state
    socket.join(room.id);
    updateRoom('id', 'players', 'teams', 'numDiscards', 'gotCards', 'stage',
      'paused', "curPlayer", "prevPlayer", "turnCountdown", "numCardsLeft",
      "turnTime", "curCard", "discards", "turnPhase");
  });

  socket.on("add_words", function(msg) {
    if (player.addedWords) return;
    room.bowlCards.push(...msg.words);
    logInfo(player.name + " in room " + room.id + " added words", ...msg.words);
    player.addedWords = true;
    updateRoom('players');
  });

  socket.on('change_team', function() {
    if (!player || !room.id) return;
    player.team = 3 - player.team;
    updateRoom('players');
  });

  function nextPlayer() {
    // change team. find least-recently-played member of that team. random if tie.
    let team = (room.curPlayer >= 0) ? (3 - room.players[room.curPlayer].team) : (rand(2) + 1);
    let min_last_played = -1;
    let possible_next_players = [];
    for (let i in room.players) {
      if (room.players[i].team == team) {
        if (min_last_played < 0 || room.players[i].last_played <= min_last_played) {
          if (room.players[i].last_played < min_last_played) possible_next_players = [];
          min_last_played = room.players[i].last_played;
          possible_next_players.push(i);
        }
      }
    }
    if (possible_next_players.length == 0) {
      //couldn't find any player on other team.
      return (room.curPlayer + 1) % room.players.length;
    } else {
      return randElement(possible_next_players);
    }
  }

  // Called for time out or no more cards. Moves to post-turn phase.
  function endTurn() {
    if (room.curCard) {
      room.cardTimes[room.curCard] = (room.cardTimes[room.curCard] || 0) + Date.now() - room.lastNewCardTime;
      room.discards.push(room.curCard);
      room.curCard = null;
    }
    room.turnPhase = 'post';
    updateRoom("turnPhase", "discards", "numDiscards");
  }

  // Called at start, or 'End Turn' button click in post-turn. Moves to pre-turn.
  function nextTurn() {
    // move discards back to deck.
    room.bowlCards.push(...room.discards.splice(0));
    // move got cards to player's hand.
    if (room.curPlayer >= 0) {
      room.players[room.curPlayer].gotCards.push(...room.gotCards.splice(0));
    }
    let rollover = false;
    if (room.bowlCards.length == 0) {
      // next round! All cards back in the deck.
      room.players.forEach(
        (p) => room.bowlCards.push(...p.gotCards.splice(0)));
      // increment stage
      if (room.stage == "round1") room.stage = "round2";
      else if (room.stage == "round2") room.stage = "round3";
      else room.stage = "postgame";
      // Allow curplayer to spend rest of their turn if there's a lot left.
      rollover = (room.turnTime >= MIN_TIME_ROLLOVER);
    }
    if (room.stage != "postgame") {
      room.turnPhase = 'pre';
      room.turnCountdown = -1; //waiting for next player to start turn
      if (!rollover) {
        room.curPlayer = nextPlayer();
        room.turnTime = TURN_TIME_SECONDS;
      }
      if (room.stage == "round3") room.turnTime *= 2;
    } else {
      updateRoom("cardTimes");
    }
    updateRoom("discards", "numDiscards", "gotCards", "numCardsLeft",
               "stage", "curPlayer", "turnCountdown", "turnPhase", "turnTime");
  }

  function startTurn() {
    logInfo("starting " + room.players[room.curPlayer].name + "'s turn in " + room.stage + " of " + room.id);
    startCountdown('turnTime', room.turnTime, endTurn);
    room.lastNewCardTime = Date.now();
    room.turnPhase = 'in';
    updateRoom("turnPhase");
  }

  socket.on('start_turn', function() {
    if (room.curPlayer != player_index) {
      logError(ip, room.id, player_index + " tried to start " + room.curPlayer + "'s turn");
      return;
    }
    room.players[room.curPlayer].last_played = Date.now();
    sendNewCard(room);
    startCountdown('turnCountdown', TURN_COUNTDOWN, startTurn);
  });

  socket.on('start_game', function() {
    if (!player.isAdmin) return;
    let N = (CARDS_PER_PLAYER * room.players.length) - room.bowlCards.length;
    if (N > 0) room.bowlCards.push(...selectNCards(N));
    room.stage = "round1";
    nextTurn();
  });

  function consumeCard(card, pile) {
    if (room.curPlayer != player_index) return;
    if (room.paused) return;
    if (!card || card != room.curCard) return;
    room.cardTimes[card] = (room.cardTimes[card] || 0) + Date.now() - room.lastNewCardTime;
    room[pile].push(room.curCard);
    room.curCard = null;
    if (pile == "gotCards") room.teams[player.team].score += pointsForStage(room.stage);
    if (room.bowlCards.length == 0) {
      // race condition with interval timer. make sure we haven't ended turn.
      if (room._interval_turnTime) {
        clearInterval(room._interval_turnTime);
        endTurn();
      }
    } else {
      sendNewCard(room);
    }
  }

  socket.on('got_card', function(msg) {
    consumeCard(msg.card, "gotCards");
    updateRoom('teams', 'gotCards', 'numCardsLeft');
  });

  socket.on('pass_card', function(msg) {
    consumeCard(msg.card, "discards");
    updateRoom('numDiscards', 'numCardsLeft', 'discards');
  });

  socket.on('end_turn', function() {
    if (room.curPlayer != player_index) return;
    nextTurn();
  });

  socket.on('pause', function() {
    if (room.paused) return;
    room.lastPausedTime = Date.now();
    room.paused = true;
    updateRoom('paused');
  });

  socket.on('unpause', function() {
    if (!room.paused) return;
    if (room.curCard && room.lastNewCardTime) {
      room.lastNewCardTime += Date.now() - room.lastPausedTime;
    }
    room.paused = false;
    updateRoom('paused');
  });

  socket.on('undo_card', function(msg) {
    if (room.curPlayer != player_index) return;
    if (msg.pile == 'got') {
      if (tryMoveElement(room.gotCards, room.discards, msg.card)) {
        room.teams[player.team].score -= pointsForStage(room.stage);
      }
    } else if (msg.pile == 'pass') {
      if (tryMoveElement(room.discards, room.gotCards, msg.card)) {
        room.teams[player.team].score += pointsForStage(room.stage);
      }
    }
    updateRoom('gotCards', 'numDiscards', 'discards', 'teams');
  });

  socket.on("new_game", function() {
    if (!player.isAdmin) return;
    room.curPlayer = -1;
    room.teams.forEach(function(team) {
      team.score = 0;
    });
    room.players.forEach(function(player) {
      player.addedWords = false;
      player.gotCards = [];
    });
    room.bowlCards = [];
    room.discards = [];
    room.gotCards = [];
    room.stage = 'pregame';
    room.paused = false;
    room.cardTimes = {};
    updateRoom('curPlayer', 'teams', 'bowlCards', 'discards', 'gotCards', 'stage', 'paused', 'players');
    logInfo(room.id + " playing new game");
  });
});

http.listen(PORT, function() {
  logInfo("Listening on " + PORT);
});


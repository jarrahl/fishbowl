// constants
var teamColors = ["", "#ff0000", "#0000ff"];
var stageInfo = {round1: {name: "Round 1", action: "give verbal", action_gerund: "giving verbal"},
                 round2: {name: "Round 2", action: "give one-word", action_gerund: "giving one-word"},
                 round3: {name: "Round 3", action: "act out", action_gerund: "acting out"}};

// global objects, utils
var socket = io();
var turnTimer;
var template = {};


// game state
function defaultRoomState() {
  return {stage: "lobby"};
}
var room = defaultRoomState();
var me = {};
var myName = '';
var turn = {}; // curCard, discards

// Util functions
function loadTemplates() {
  for (const id of ["players", "resolved_cards", "custom_words"]) {
    template[id] = $("#template_"+id).html();
  }
}

function clickAddWords() {
  let customWords = [];
  $(".customWord").each(
    function() { 
      let word = $(this).val().trim();
      if (word) customWords.push(word);
    }
  )
  socket.emit("add_words", {words: customWords});
}

function renderPlayerList() {
  function playerInfo(p) {
    return {'name': p.name, 'team': room.teams[p.team].name,
            'team_color': teamColors[p.team], 'isMe': (p == me),
            'addedWords': p.addedWords || false};
  }
  $("#playersDiv").html(Mustache.render(template.players,
    {player: room.players.map(playerInfo)}));
  $("#changeTeamButton").click(function() { socket.emit('change_team'); });
  $("#addCustomWordsButton").click(clickAddWords);
}

function setVisibility(selector, visible) {
  if (visible) $(selector).show();
  else $(selector).hide();
}

function winningTeamsString() {
  let max_score = Math.max(...room.teams.map(team => team.score || 0));
  return room.teams.filter(team => team.score == max_score).map(team => team.name).join(" and ");
}

function argMax(dict) {
  return Object.keys(dict).reduce((r, a) => (dict[a] > dict[r] ? a : r));
}

function argMin(dict) {
  return Object.keys(dict).reduce((r, a) => (dict[a] < dict[r] ? a : r));
}

function cardStatsString() {
  let hardest = argMax(room.cardTimes);
  let easiest = argMin(room.cardTimes);
  return "Hardest card: \"" + hardest + "\" took " + Math.floor(room.cardTimes[hardest] / 1000) + " seconds" +
         "<br><br>" +
         "Easiest card: \"" + easiest + "\" took " + Math.floor(room.cardTimes[easiest] / 1000) + " seconds";
}

function numPoints(numCards, stage) {
  if (stage == "round1") return numCards;
  if (stage == "round2") return numCards * 2;
  if (stage == "round3") return numCards * 3;
  return 0; 
}

function pluralise(n, str) {
    return n + " " + str + (n != 1 ? "s" : "");
}

function renderState() {
  console.log("rendering stage " + room.stage);
  if (room.id) $("#roomIdDiv").text(room.id);
  if (room && room.stage != "lobby") {
    $("#statusDiv").html(myName + " / " + "Team " + room.teams[me.team].name).css("color", teamColors[me.team]);
  }
  if (($(".customWord").length == 0) != (me.addedWords || false)) {
    $("#customWordsDiv").html(Mustache.render(template.custom_words,
      {addedWords: me.addedWords || 0}));
  }
  setVisibility("#lobbyDiv", room.stage == 'lobby');
  setVisibility("#pregameDiv", room.stage == 'pregame');
  setVisibility("#gameDiv", room.stage.startsWith("round") || room.stage == "postgame");
  setVisibility("#newGameButton", room.stage == 'postgame' && me.isAdmin);

  if (room.stage == 'pregame') {
    renderPlayerList();
    setVisibility('#startGameButton', me.isAdmin);
  }
  if (room.stage.startsWith("round") || room.stage == 'postgame') {
    $("#teamScoresDiv").empty();
    for (let [id, team] of room.teams.entries()) {
      if (team.name) {
        $("#teamScoresDiv").
          append("<span class=\"teamName\">Team " + team.name + "</span>").
          append("<span class=\"teamScore\">" + team.score + "</span>");
      }
    }
    setVisibility("#waitingForDiv", true);
  }
  if (room.stage == "postgame") {
    $("#waitingForDiv").html("Game over! Congratulations " + winningTeamsString() + "!");
    if (room.cardTimes) $("#waitingForDiv").append("<br><br>" + cardStatsString(room.cardTimes));
    $("#endTurnButton").hide();
    $("#resolvedCardsDiv").hide();
  }
  if (room.stage.startsWith("round")) {
    let curPlayer = room.players[room.curPlayer];
    // 3 turn phases: 'pre', 'in', 'post'.
    let phase = room.turnPhase;
    setVisibility('#myTurnDiv', (curPlayer == me && phase == 'in'));
    setVisibility('#startTurnButton', curPlayer == me &&
                                      phase == 'pre' &&
                                      room.turnCountdown < 0);
    setVisibility('#endTurnButton', curPlayer == me &&
                                    phase == 'post');
    setVisibility("#turnTimeDiv", room.turnTime != null);
    setVisibility("#pauseButton", room.turnTime != null && phase == 'in');
    if (room.turnTime !== null) $("#turnTimeSpan").html("00:" + (room.turnTime < 10 ? "0" : "") + room.turnTime);
    setVisibility("#resolvedCardsDiv", phase == 'in' || phase == 'post');

    if (phase == 'pre') {
      if (room.turnCountdown > 0) {
        $("#waitingForDiv").html(curPlayer.name + "'s turn in " + room.turnCountdown + "...");
      } else {
        $("#waitingForDiv").html(curPlayer.name + " will now " + stageInfo[room.stage].action + " clues to " + room.teams[curPlayer.team].name + ".");
      }
    } else if (phase == 'in') {
      if (curPlayer == me) {
        $("#waitingForDiv").html("You are " + stageInfo[room.stage].action_gerund + " clues to " + room.teams[curPlayer.team].name);
      } else {
        $("#waitingForDiv").html(curPlayer.name + " is " + stageInfo[room.stage].action_gerund + " clues to " + room.teams[curPlayer.team].name);
      }
    } else if (phase == 'post') {
      $("#waitingForDiv").empty();
      $("#waitingForDiv").append("Turn finished (" + (room.numCardsLeft == 0 ? "no cards left in deck" : "out of time") + ").<br><br>");
      $("#waitingForDiv").append(
        room.players[room.curPlayer].name + " got " + 
        pluralise(numPoints(room.gotCards.length, room.stage), "point") + " for " + 
        room.teams[room.players[room.curPlayer].team].name + ".<br><br>");
      if (room.numDiscards > 0) $("#waitingForDiv").append(pluralise(room.numDiscards, "passed card") + " will be returned to the deck.<br><br>");
      if (room.numDiscards == 0 && room.numCardsLeft == 0) {
        // round is over.
        $("#waitingForDiv").append(stageInfo[room.stage].name + " has finished.");
        if (room.stage != "round3") {
          $("#waitingForDiv").append(" All cards will return to the deck.");
        }
        $("#waitingForDiv").append("<br><br>");
      }
    }
    $("#resolvedCardsDiv").html(Mustache.render(template.resolved_cards,
      {numGot: room.gotCards.length,
      gotCards: room.gotCards,
      numPassed: room.numDiscards,
      passedCards: turn.discards || []
      }));
    if (curPlayer == me) {
      // Undo got/passed cards
      selectedCardIndex = $(".resolvedCardsList li.selected").index() + 1; // 0 if no selected card.
      selectedCardList = $(".resolvedCardsList li.selected").parent().attr('id') || null;
      if (selectedCardList) {
        $("#" + selectedCardList + " li:nth-child(" + selectedCardIndex
          + ")").addClass("selected");
      }
      $(".resolvedCardsList li").click(function() {
        if ($(this).hasClass("selected")) {
          $(this).removeClass("selected");
        } else {
          $(".resolvedCardsList li.selected").removeClass("selected");
          $(this).addClass("selected");
        }
        setVisibility("#undoButton", $(".resolvedCardsList li.selected").length); 
      });
    }
    setVisibility("#undoButton", $(".resolvedCardsList li.selected").length);

    // Pause/start game button
    if (room.paused) $("#pauseButton").addClass("paused");
    else $("#pauseButton").removeClass("paused");
    $("#cardButtons").css("opacity", room.paused ? 0.5 : 1.0);
  }
  $("#deckDiv").html(room.numCardsLeft);
}

function playFromStart(audioSelector) {
    let element = document.getElementById(audioSelector);
    element.currentTime = 0;
    element.play();
}

$(function() {
  loadTemplates();

  // Button listeners
  $('#joinButton').click(function(e) {
    e.preventDefault(); // no full page reload
    myName = $('#nameInput').val().toLowerCase().trim();
    socket.emit('join_room', 
    {name: myName,
     room_id: $('#roomIdInput').val()});
    return false;
  });
  $('#startGameButton').click(function() {
    socket.emit('start_game');
  });
  $('#startTurnButton').click(function() {
    console.log("trying to start turn");
    socket.emit('start_turn');
  });
  $('#endTurnButton').click(function() {
    socket.emit('end_turn');
  });
  $('#gotCardButton').click(function() {
      playFromStart("gotitAudio");
      socket.emit('got_card', {card: turn.curCard});
  });
  $('#passCardButton').click(function() {
      playFromStart("passAudio");
      socket.emit('pass_card', {card: turn.curCard});
  });
  $('#undoButton').click(function() {
    let selected = $(".resolvedCardsList li.selected");
    let pile = (selected.parent().attr('id') == 'gotCardsList') ? 'got' : 'pass';
    console.log('undoing ' + pile + ' card ' + selected.text());
    socket.emit('undo_card', {pile: pile, card: selected.text()});
    $(".resolvedCardsList li.selected").removeClass("selected");
    $("#undoButton").hide();
  });
  $("#pauseButton").click(function() {
    if (room.paused) {
      socket.emit("unpause");
    } else {
      socket.emit("pause");
    }
  });
  $("#newGameButton").click(function() {
      socket.emit("new_game");
  });

  //Socket listeners
  socket.on('room_state', function(room_delta) {
    if (room_delta.turnTime === 0 && room.turnTime > 0 && me == room.players[room.curPlayer]) {
      playFromStart("timeUpAudio");
    }
    for (let property in room_delta) {
      console.log("updating " + property + " to " +
        JSON.stringify(room_delta[property]));
      room[property] = room_delta[property];
    }
    me = room.players.find(p => p.name == myName);
    if (me != room.players[room.curPlayer]) turn = {};
    renderState();
  });
  socket.on('join_room_error', function(err) {
    $("#statusDiv").text(err);
  });
  socket.on("turn_state", function(turn_delta) {
    for (let property in turn_delta) {
      console.log("updating " + property + " to " +
        JSON.stringify(turn_delta[property]));
      turn[property] = turn_delta[property];
    }
    renderState();
    console.log("turn state " + JSON.stringify(turn));
    $("#currentCardDiv").text(turn.curCard);
  });
  socket.on('disconnect', function disconnectRoom(){
    if (room.stage == "lobby") return;
    $("#nameInput").val(me.name || "");
    $("#roomIdInput").val(room.id || "");
    room = defaultRoomState();
    renderState();
    $("#statusDiv").text("Disconnected from room").css("color", "black");
  });
});
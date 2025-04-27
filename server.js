// server.js (Node.js 서버)
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 정적 파일 제공
app.use(express.static(path.join(__dirname, "public")));

// 데이터 저장소 (실제 서비스에서는 데이터베이스 사용 권장)
const gameData = {
  courts: [
    { id: 1, inUse: false, players: [] },
    { id: 2, inUse: false, players: [] },
    { id: 3, inUse: false, players: [] },
    { id: 4, inUse: false, players: [] }
  ],
  teams: {
    team1: { name: "1조", queue: [] },
    team2: { name: "2조", queue: [] },
    menDouble: { name: "남복조", queue: [] },
    womenDouble: { name: "여복조", queue: [] }
  },
  users: {}
};

// Socket.io 연결 처리
io.on("connection", socket => {
  console.log("새로운 사용자가 연결되었습니다:", socket.id);

  // 초기 데이터 전송
  socket.emit("initialData", gameData);

  // 사용자 등록
  socket.on("registerUser", userData => {
    const userId = socket.id;
    gameData.users[userId] = {
      id: userId,
      name: userData.name,
      createdAt: new Date().toISOString()
    };

    // 모든 클라이언트에 사용자 목록 갱신 전달
    io.emit("usersUpdated", Object.values(gameData.users));

    // 사용자 정보 저장 확인
    socket.emit("userRegistered", gameData.users[userId]);
  });

  // 사용자 이름 변경
  socket.on("changeUserName", newName => {
    const userId = socket.id;
    if (gameData.users[userId]) {
      gameData.users[userId].name = newName;

      // 모든 클라이언트에 사용자 목록 갱신 전달
      io.emit("usersUpdated", Object.values(gameData.users));

      // 대기열과 코트에 있는 사용자 이름도 모두 갱신
      updatePlayerNameInQueues(userId, newName);
      updatePlayerNameInCourts(userId, newName);

      // 전체 데이터 갱신
      io.emit("dataUpdated", gameData);
    }
  });

  // 대기열에 추가
  socket.on("addToQueue", data => {
    const userId = socket.id;
    const teamKey = data.teamKey;
    const user = gameData.users[userId];

    if (!user) return;

    // 이미 대기열에 등록되었는지 확인
    for (const key in gameData.teams) {
      if (gameData.teams[key].queue.some(player => player.id === userId)) {
        socket.emit("error", "이미 대기열에 등록되어 있습니다.");
        return;
      }
    }

    // 코트에서 플레이 중인지 확인
    for (const court of gameData.courts) {
      if (court.players.some(player => player.id === userId)) {
        socket.emit("error", "현재 게임 중입니다.");
        return;
      }
    }

    // 대기열 크기 확인
    if (gameData.teams[teamKey].queue.length >= 15) {
      socket.emit("error", `${gameData.teams[teamKey].name}의 대기열이 가득 찼습니다.`);
      return;
    }

    // 대기열에 추가
    gameData.teams[teamKey].queue.push({
      id: userId,
      name: user.name,
      joinedAt: new Date().toISOString()
    });

    // 모든 클라이언트에 데이터 갱신 전달
    io.emit("dataUpdated", gameData);

    // 자동 매칭 시도
    tryMatchGame();
  });

  // 선수 추가 (외부 플레이어)
  socket.on("addExternalPlayer", data => {
    const userId = socket.id;
    const teamKey = data.teamKey;
    const playerName = data.playerName;

    // 대기열 크기 확인
    if (gameData.teams[teamKey].queue.length >= 15) {
      socket.emit("error", `${gameData.teams[teamKey].name}의 대기열이 가득 찼습니다.`);
      return;
    }

    // 임시 ID 생성
    const tempId = `external_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // 대기열에 추가
    gameData.teams[teamKey].queue.push({
      id: tempId,
      name: playerName,
      joinedAt: new Date().toISOString(),
      addedBy: userId
    });

    // 모든 클라이언트에 데이터 갱신 전달
    io.emit("dataUpdated", gameData);

    // 자동 매칭 시도
    tryMatchGame();
  });

  // 대기열에서 제거
  socket.on("removeFromQueue", data => {
    const userId = socket.id;
    const teamKey = data.teamKey;
    const playerId = data.playerId;

    const team = gameData.teams[teamKey];
    const playerIndex = team.queue.findIndex(player => player.id === playerId);

    if (playerIndex !== -1) {
      const player = team.queue[playerIndex];

      // 본인 또는 본인이 추가한 선수만 제거 가능
      if (player.id === userId || player.addedBy === userId) {
        team.queue.splice(playerIndex, 1);

        // 모든 클라이언트에 데이터 갱신 전달
        io.emit("dataUpdated", gameData);
      } else {
        socket.emit("error", "자신이 등록한 대기열만 취소할 수 있습니다.");
      }
    }
  });

  // 코트 상태 변경
  socket.on("toggleCourtStatus", courtId => {
    const court = gameData.courts.find(c => c.id === courtId);
    if (court) {
      court.inUse = !court.inUse;

      // 사용 안 함으로 변경시 플레이어 제거
      if (!court.inUse) {
        court.players = [];
      }

      // 모든 클라이언트에 데이터 갱신 전달
      io.emit("dataUpdated", gameData);
    }
  });

  // 게임 종료
  socket.on("endGame", courtId => {
    const court = gameData.courts.find(c => c.id === courtId);
    if (court) {
      court.inUse = false;
      court.players = [];

      // 모든 클라이언트에 데이터 갱신 전달
      io.emit("dataUpdated", gameData);
    }
  });

  // 연결 해제
  socket.on("disconnect", () => {
    console.log("사용자 연결 해제:", socket.id);

    // 사용자가 대기열에 있으면 제거
    for (const teamKey in gameData.teams) {
      const team = gameData.teams[teamKey];
      const playerIndex = team.queue.findIndex(player => player.id === socket.id);

      if (playerIndex !== -1) {
        team.queue.splice(playerIndex, 1);
      }
    }

    // 사용자 목록에서 제거
    delete gameData.users[socket.id];

    // 모든 클라이언트에 데이터 갱신 전달
    io.emit("dataUpdated", gameData);
    io.emit("usersUpdated", Object.values(gameData.users));
  });
});

// 대기열에서 사용자 이름 갱신
function updatePlayerNameInQueues(userId, newName) {
  for (const teamKey in gameData.teams) {
    const queue = gameData.teams[teamKey].queue;
    for (const player of queue) {
      if (player.id === userId) {
        player.name = newName;
      }
    }
  }
}

// 코트에서 사용자 이름 갱신
function updatePlayerNameInCourts(userId, newName) {
  for (const court of gameData.courts) {
    for (const player of court.players) {
      if (player.id === userId) {
        player.name = newName;
      }
    }
  }
}

// 자동 게임 매칭 로직
function tryMatchGame() {
  for (const teamKey in gameData.teams) {
    const queue = gameData.teams[teamKey].queue;

    // 대기열에 4명 이상 있는지 확인
    if (queue.length >= 4) {
      // 사용 가능한 코트 찾기
      const availableCourt = gameData.courts.find(court => !court.inUse);

      if (availableCourt) {
        // 앞에서부터 4명 선택하여 게임 매칭
        const matchedPlayers = queue.slice(0, 4);

        // 코트에 선수 배정
        availableCourt.inUse = true;
        availableCourt.players = matchedPlayers.map(player => ({
          id: player.id,
          name: player.name
        }));

        // 대기열에서 제거
        gameData.teams[teamKey].queue = queue.slice(4);

        // 모든 클라이언트에 데이터 갱신 전달
        io.emit("dataUpdated", gameData);

        // 한 번에 하나의 매칭만 처리
        break;
      }
    }
  }
}

// 서버 시작
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});

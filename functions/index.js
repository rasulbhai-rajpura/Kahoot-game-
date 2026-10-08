const { onValueCreated } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.database();

const REGION = "asia-south1";

/*
 * ============================================================
 * KAHOOT PRO - SECURE SERVER
 * ============================================================
 * 1. Server-side score validation
 * 2. Answer timeout validation
 * 3. Double-score protection
 * 4. Atomic score update
 * 5. Room-specific questions
 * 6. Expired room cleanup
 * ============================================================
 */


/**
 * ------------------------------------------------------------
 * PROCESS PLAYER ANSWER
 * ------------------------------------------------------------
 *
 * Trigger:
 * /rooms/{pin}/answers/{qIdx}/{uid}
 *
 * Player answer is received by Firebase.
 * Score is calculated ONLY on the server.
 */
exports.processQuizAnswer = onValueCreated(
  {
    ref: "/rooms/{pin}/answers/{qIdx}/{uid}",
    region: REGION
  },
  async (event) => {
    const pin = event.params.pin;
    const qIdx = event.params.qIdx;
    const uid = event.params.uid;

    const answerData = event.data.val();

    if (!answerData) {
      return null;
    }

    try {
      const roomRef = db.ref(`rooms/${pin}`);
      const playerRef = db.ref(`rooms/${pin}/players/${uid}`);
      const questionRef = db.ref(`serverQuiz/${pin}/questions/${qIdx}`);
      const processedRef = db.ref(
        `rooms/${pin}/processedQuestions/${qIdx}/${uid}`
      );

      const [roomSnap, playerSnap, questionSnap, processedSnap] =
        await Promise.all([
          roomRef.once("value"),
          playerRef.once("value"),
          questionRef.once("value"),
          processedRef.once("value")
        ]);

      const room = roomSnap.val();
      const player = playerSnap.val();
      const question = questionSnap.val();

      if (!room || !player || !question) {
        console.log("Invalid room/player/question:", pin, uid, qIdx);
        return null;
      }

      /*
       * --------------------------------------------------------
       * DOUBLE SCORE PROTECTION
       * --------------------------------------------------------
       */
      if (processedSnap.exists()) {
        console.log("Answer already processed:", pin, qIdx, uid);
        return null;
      }

      /*
       * --------------------------------------------------------
       * CHECK CURRENT QUESTION
       * --------------------------------------------------------
       */
      const currentQuestion = Number(room.currentQuestion);

      if (currentQuestion !== Number(qIdx)) {
        console.log("Old question answer rejected:", pin, qIdx);
        return null;
      }

      /*
       * --------------------------------------------------------
       * CHECK GAME STATE
       * --------------------------------------------------------
       */
      const state = room.state || "";

      if (
        state !== "question" &&
        state !== "asking" &&
        state !== "active"
      ) {
        console.log("Question is not active:", pin, state);
        return null;
      }

      /*
       * --------------------------------------------------------
       * SERVER QUESTION START TIME
       * --------------------------------------------------------
       */
      const questionStartTime = Number(room.questionStartTime || 0);

      if (!questionStartTime) {
        console.log("Missing question start time:", pin);
        return null;
      }

      /*
       * --------------------------------------------------------
       * QUESTION TIME LIMIT
       * --------------------------------------------------------
       */
      const duration = Number(
        room.questionDuration ||
        room.duration ||
        question.duration ||
        30
      );

      const now = Date.now();

      const elapsed = now - questionStartTime;

      /*
       * --------------------------------------------------------
       * TIMEOUT VALIDATION
       * --------------------------------------------------------
       */
      if (elapsed > duration * 1000) {
        console.log("Late answer rejected:", {
          pin,
          qIdx,
          uid,
          elapsed,
          duration
        });

        /*
         * Mark as processed so the same late answer
         * cannot repeatedly trigger processing.
         */
        await processedRef.set({
          accepted: false,
          reason: "timeout",
          processedAt: admin.database.ServerValue.TIMESTAMP
        });

        return null;
      }

      /*
       * --------------------------------------------------------
       * VALIDATE ANSWER
       * --------------------------------------------------------
       */
      const submittedAnswer = String(answerData.ans || "")
        .trim()
        .toLowerCase();

      if (!/^[abcd]$/.test(submittedAnswer)) {
        console.log("Invalid answer:", submittedAnswer);
        return null;
      }

      /*
       * --------------------------------------------------------
       * CORRECT ANSWER
       *
       * The correct answer comes from serverQuiz,
       * NOT from the public room data.
       * --------------------------------------------------------
       */
      const correctAnswer = String(
        question.correctAnswer ||
        question.correct ||
        question.answer ||
        ""
      )
        .trim()
        .toLowerCase();

      if (!/^[abcd]$/.test(correctAnswer)) {
        console.log("Invalid server correct answer:", pin, qIdx);
        return null;
      }

      /*
       * --------------------------------------------------------
       * SCORE CALCULATION
       * --------------------------------------------------------
       */

      const isCorrect = submittedAnswer === correctAnswer;

      let points = 0;
      let newStreak = Number(player.streak || 0);

      if (isCorrect) {
        /*
         * Speed score:
         * Maximum = 1000
         * Minimum correct score = 100
         */
        const remaining =
          Math.max(
            0,
            duration * 1000 - elapsed
          );

        const speedRatio =
          duration > 0
            ? remaining / (duration * 1000)
            : 0;

        points = Math.round(
          100 +
          900 * Math.max(0, Math.min(1, speedRatio))
        );

        newStreak += 1;
      } else {
        newStreak = 0;
        points = 0;
      }

      /*
       * --------------------------------------------------------
       * ATOMIC SCORE UPDATE
       * --------------------------------------------------------
       *
       * Firebase transaction prevents two simultaneous
       * updates from overwriting each other.
       */
      await playerRef.transaction((currentPlayer) => {
        if (!currentPlayer) {
          return currentPlayer;
        }

        const oldScore = Number(currentPlayer.score || 0);

        /*
         * Extra protection:
         * If this question was already recorded in the player
         * object, do not add points again.
         */
        const lastQuestion =
          currentPlayer.lastProcessedQuestion;

        if (String(lastQuestion) === String(qIdx)) {
          return;
        }

        currentPlayer.score = oldScore + points;
        currentPlayer.streak = newStreak;

        currentPlayer.lastCorrect = isCorrect;
        currentPlayer.lastPoints = points;
        currentPlayer.lastProcessedQuestion = String(qIdx);

        return currentPlayer;
      });

      /*
       * --------------------------------------------------------
       * MARK ANSWER AS PROCESSED
       * --------------------------------------------------------
       */
      await processedRef.set({
        accepted: true,
        correct: isCorrect,
        points: points,
        processedAt: admin.database.ServerValue.TIMESTAMP
      });

      console.log("Answer processed successfully:", {
        pin,
        qIdx,
        uid,
        isCorrect,
        points
      });

      return null;

    } catch (error) {
      console.error(
        "processQuizAnswer error:",
        error
      );

      return null;
    }
  }
);


/**
 * ------------------------------------------------------------
 * CLEANUP EXPIRED ROOMS
 * ------------------------------------------------------------
 *
 * Runs every 30 minutes.
 */
exports.cleanupExpiredRooms = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Asia/Kolkata",
    region: REGION
  },
  async () => {
    try {
      const roomsSnap = await db.ref("rooms").once("value");

      if (!roomsSnap.exists()) {
        console.log("No rooms found.");
        return null;
      }

      const rooms = roomsSnap.val();
      const now = Date.now();

      const updates = {};

      Object.keys(rooms).forEach((pin) => {
        const room = rooms[pin];

        if (!room) {
          return;
        }

        const expiresAt = Number(room.expiresAt || 0);

        if (expiresAt > 0 && expires

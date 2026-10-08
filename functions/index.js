const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.database();

/**
 * સુધારો ૨, ૩, ૪ અને ૭:
 * જ્યારે કોઈ વિદ્યાર્થી નવો જવાબ સબમિટ કરે ત્યારે આ ફંક્શન ટ્રિગર થાય છે.
 */
exports.validateAndScoreAnswer = functions.database
  .ref("/rooms/{pin}/answers/{qIdx}/{uid}")
  .onCreate(async (snapshot, context) => {
    const { pin, qIdx, uid } = context.params;
    const answerData = snapshot.val();
    const studentAns = (answerData.ans || "").toLowerCase().trim();
    const answerSubmittedAt = answerData.time; // Server timestamp

    const roomRef = db.ref(`rooms/${pin}`);
    const quizRef = db.ref(`serverQuiz/${pin}/questions/${qIdx}`);

    const [roomSnap, quizSnap] = await Promise.all([
      roomRef.once("value"),
      quizRef.once("value")
    ]);

    const room = roomSnap.val();
    const quizItem = quizSnap.val();

    if (!room || !quizItem) return null;

    // ૧. Timeout Validation: પ્રશ્ન બંધ થઈ ગયો છે કે સમય સમાપ્ત થયો છે?
    const qStartTime = room.questionStarts ? room.questionStarts[qIdx] : null;
    const qClosedAt = room.questionClosedAt ? room.questionClosedAt[qIdx] : null;
    const durationMs = (room.questionDuration || 30) * 1000;

    // જો હોસ્ટે પ્રશ્ન બંધ કરી દીધો હોય અથવા સમય મર્યાદા વટાવી ગઈ હોય તો જવાબ અમાન્ય
    if (qClosedAt && answerSubmittedAt > qClosedAt) {
      console.log(`[Rejected] Late submission by ${uid} for Q${qIdx}`);
      return null;
    }
    if (qStartTime && (answerSubmittedAt - qStartTime > durationMs + 2000)) { // 2s નેટવર્ક ગ્રેસ ટાઇમ
      console.log(`[Rejected] Timeout by ${uid} for Q${qIdx}`);
      return null;
    }

    const isCorrect = studentAns === (quizItem.correct || "").toLowerCase().trim();

    // ૨. Double-Score Protection & Atomic Update:
    // Firebase Transaction વડે ખાતરી કરીએ કે સ્કોર sequential અને overwrite વગર અપડેટ થાય
    const playerRef = db.ref(`rooms/${pin}/players/${uid}`);
    
    return playerRef.transaction((player) => {
      if (!player) return player;

      // ડબલ પ્રોસેસિંગ રોકવા
      player.processedQuestions = player.processedQuestions || {};
      if (player.processedQuestions[qIdx]) {
        return; // જો આ પ્રશ્ન પહેલેથી પ્રોસેસ થઈ ગયો હોય તો સ્કોર ન બદલો
      }

      player.processedQuestions[qIdx] = true;

      if (isCorrect) {
        player.streak = (player.streak || 0) + 1;
        // ઝડપી જવાબ માટે પોઈન્ટ્સ ગણતરી (લઘુત્તમ ૨૦૦, મહત્તમ ૧૦૦૦)
        const timeTakenMs = qStartTime ? Math.max(0, answerSubmittedAt - qStartTime) : 0;
        const timeFactor = Math.max(0, (durationMs - timeTakenMs) / durationMs);
        const basePoints = Math.round(200 + (800 * timeFactor));
        const streakBonus = player.streak > 1 ? 100 : 0;
        
        player.score = (player.score || 0) + basePoints + streakBonus;
      } else {
        player.streak = 0;
      }

      return player;
    });
  });

/**
 * સુધારો ૬: Automatic Cleanup
 * દર ૧ કલાકે આપમેળે ચાલે અને 3 કલાક કરતાં જૂના Expired રૂમ્સ અને પ્રશ્નો ડિલીટ કરે.
 */
exports.autoCleanupExpiredRooms = functions.pubsub
  .schedule("every 1 hours")
  .onRun(async (context) => {
    const now = Date.now();
    const roomsSnap = await db.ref("rooms").once("value");
    
    if (!roomsSnap.exists()) return null;

    const deletions = [];
    roomsSnap.forEach((child) => {
      const room = child.val();
      const pin = child.key;
      if (room.expiresAt && room.expiresAt < now) {
        deletions.push(db.ref(`rooms/${pin}`).remove());
        deletions.push(db.ref(`serverQuiz/${pin}`).remove());
        console.log(`[Cleanup] Deleted expired room: ${pin}`);
      }
    });

    return Promise.all(deletions);
  });

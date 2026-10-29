import dotenv from 'dotenv';
import { pool, initDb } from '../src/db.js';

dotenv.config();

// Official Year 3 Computer Science Semester 1 Schedule
export const CS_YEAR3_SCHEDULE = [
  // Monday (ចន្ទ)
  {
    day_of_week: 'MON',
    time: '17:30', // 05:30 PM
    subject: '.NET programming I (Mr. Kheam Hong)',
    room: 'Lab 205',
  },
  {
    day_of_week: 'MON',
    time: '19:15', // 07:15 PM
    subject: 'Front-End Web Dev (Mr. Thou Chamroeun)',
    room: 'Lab 205',
  },

  // Tuesday (អង្គារ)
  {
    day_of_week: 'TUE',
    time: '17:30', // 05:30 PM
    subject: 'Front-End Web Dev (Mr. Thou Chamroeun)',
    room: 'Room 109',
  },
  {
    day_of_week: 'TUE',
    time: '19:15', // 07:15 PM
    subject: 'Applied Statistics (Dr. Chor Chandara)',
    room: 'Room 109',
  },

  // Wednesday (ពុធ)
  {
    day_of_week: 'WED',
    time: '17:30', // 05:30 PM
    subject: 'Information System Analysis (Mr. Ear Eksanthan)',
    room: 'Room 107',
  },
  {
    day_of_week: 'WED',
    time: '19:15', // 07:15 PM
    subject: 'Applied Statistics (Dr. Chor Chandara)',
    room: 'Room 107',
  },

  // Thursday (ព្រហស្បតិ៍)
  {
    day_of_week: 'THU',
    time: '17:30', // 05:30 PM
    subject: 'Computer Networks I (Dr. Ouk Khean)',
    room: 'Room 110',
  },
  {
    day_of_week: 'THU',
    time: '19:15', // 07:15 PM
    subject: '.NET programming I (Mr. Kheam Hong)',
    room: 'Room 110',
  },

  // Friday (សុក្រ)
  {
    day_of_week: 'FRI',
    time: '17:30', // 05:30 PM
    subject: 'Computer Networks I (Dr. Ouk Khean)',
    room: 'Room 203',
  },
  {
    day_of_week: 'FRI',
    time: '19:15', // 07:15 PM
    subject: 'Information System Analysis (Mr. Ear Eksanthan)',
    room: 'Room 203',
  },
];

async function seed() {
  try {
    console.log('🌱 Starting Year 3 CS Schedule Seeder...');
    await initDb();

    // 1. Identify target chat_id
    let targetChatId = process.env.CHAT_ID;

    if (!targetChatId) {
      // Auto-detect from tasks table if CHAT_ID was not passed in .env
      const { rows } = await pool.query('SELECT DISTINCT chat_id FROM tasks ORDER BY chat_id LIMIT 1');
      if (rows.length > 0) {
        targetChatId = rows[0].chat_id;
        console.log(`🔍 Detected active Chat ID from database: ${targetChatId}`);
      }
    }

    if (!targetChatId) {
      console.warn('⚠️ No active Chat ID found. Please set CHAT_ID in your .env or run the /seedschedule command directly in your Telegram chat.');
      process.exit(1);
    }

    // 2. Clear existing schedules for this chat_id to prevent duplicates
    await pool.query('DELETE FROM schedules WHERE chat_id = $1', [targetChatId]);
    console.log(`🧹 Cleaned up existing schedules for Chat ID: ${targetChatId}`);

    // 3. Insert all 10 classes
    const insertQuery = `
      INSERT INTO schedules (chat_id, day_of_week, time, subject, room)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, day_of_week, time, subject, room;
    `;

    for (const item of CS_YEAR3_SCHEDULE) {
      const { rows } = await pool.query(insertQuery, [
        targetChatId,
        item.day_of_week,
        item.time,
        item.subject,
        item.room,
      ]);
      console.log(`  ✅ Added [${rows[0].day_of_week}] ${rows[0].time} — ${rows[0].subject} (${rows[0].room})`);
    }

    console.log(`\n🎉 Successfully seeded all 10 classes for Chat ID: ${targetChatId}!`);
    console.log('👉 Open Telegram and send /schedule to see your new weekly timetable.');
  } catch (err) {
    console.error('❌ Error during seeding:', err.message);
  } finally {
    await pool.end();
  }
}

seed();


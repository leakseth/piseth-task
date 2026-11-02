import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import dns from 'dns';
import http from 'http';
import crypto from 'crypto';
import {
  initDb,
  createTask,
  getTasksByChatId,
  markTaskAsCompleted,
  deleteTask,
  createSchedule,
  getSchedulesByChatId,
  getTodaySchedulesByChatId,
  deleteSchedule,
  pool,
} from './db.js';
import {
  startScheduler,
  TIMEZONE,
  getCurrentTimeString,
  getCurrentDayOfWeek,
  getDayName,
} from './scheduler.js';
import {
  translateKhmerToEnglish,
  translateEnglishToKhmer,
  fixEnglishGrammar,
  getActiveAiProvider,
} from './translator.js';

// Force Node.js to use IPv4 first (prevents ECONNRESET on networks with broken/throttled IPv6)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  // Ignored on older Node versions
}

// Load environment variables
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ Error: BOT_TOKEN is missing in your .env file.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Helper: convert 24h HH:mm to friendly 12h format (e.g. 14:15 -> 2:15 PM)
function formatTo12Hour(time24) {
  const [h, m] = time24.split(':').map((v) => parseInt(v, 10));
  const period = h >= 12 ? 'PM' : 'AM';
  const hours12 = h % 12 || 12;
  return `${hours12}:${String(m).padStart(2, '0')} ${period}`;
}

// Helper: parse and validate time supporting both 24h (14:30) and 12h AM/PM (2:30 PM, 2:30pm)
function parseAndValidateTime(timeStr) {
  if (!timeStr) return null;
  const clean = timeStr.trim();

  // 1. Check for 12-hour format with AM/PM (e.g., "2:13 PM", "02:13pm", "2:13am")
  const ampmRegex = /^([0]?[1-9]|1[0-2]):([0-5]\d)\s*(am|pm)$/i;
  const ampmMatch = clean.match(ampmRegex);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2];
    const modifier = ampmMatch[3].toUpperCase();

    if (modifier === 'PM' && hours < 12) {
      hours += 12;
    } else if (modifier === 'AM' && hours === 12) {
      hours = 0;
    }
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  // 2. Check for standard 24-hour format (e.g., "14:13", "02:13")
  const militaryRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const militaryMatch = clean.match(militaryRegex);
  if (militaryMatch) {
    const hours = militaryMatch[1].padStart(2, '0');
    const minutes = militaryMatch[2];
    return `${hours}:${minutes}`;
  }

  return null;
}

// Helper: Normalize day of week (MON, TUE, WED, THU, FRI, SAT, SUN)
function normalizeDayOfWeek(dayStr) {
  if (!dayStr) return null;
  const clean = dayStr.trim().toUpperCase();
  const map = {
    MON: 'MON', MONDAY: 'MON',
    TUE: 'TUE', TUESDAY: 'TUE',
    WED: 'WED', WEDNESDAY: 'WED',
    THU: 'THU', THURSDAY: 'THU',
    FRI: 'FRI', FRIDAY: 'FRI',
    SAT: 'SAT', SATURDAY: 'SAT',
    SUN: 'SUN', SUNDAY: 'SUN',
  };
  return map[clean] || null;
}

// Helper: Escape HTML entities to prevent Telegram parse errors
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// Translation Sessions Cache (Avoids Telegram 64-byte callback_data limit)
// -------------------------------------------------------------
const translationStore = new Map();

function saveTranslationSession(text, chatId) {
  const id = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).substring(2, 10);
  translationStore.set(id, {
    text,
    chatId,
    timestamp: Date.now(),
  });

  // Prune sessions older than 2 hours if map grows large
  if (translationStore.size > 200) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [key, value] of translationStore.entries()) {
      if (value.timestamp < twoHoursAgo) {
        translationStore.delete(key);
      }
    }
  }

  return id;
}

// Extract original text from memory store or directly from message text if session expired
function getTranslationText(sessionId, ctx) {
  const session = translationStore.get(sessionId);
  if (session && session.text) {
    return session.text;
  }

  // Fallback: Attempt to extract from previous message text
  const msgText = ctx.callbackQuery?.message?.text || '';
  const match = msgText.match(/(?:Input Text|Original[^:]*):\s*\n([\s\S]+?)(?:\n\n|\nChoose|$)/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

// Command: /start
bot.start((ctx) => {
  const firstName = ctx.from?.first_name || 'there';
  const currentTime = getCurrentTimeString(TIMEZONE);

  const welcomeMessage = 
`👋 Hello ${firstName}! Welcome to your *Personal Task & Reminder Bot*.

I help you stay organized with reminder alerts, university class schedules, and smart translation!

🕒 *Current Bot Time:* \`${currentTime}\` (Timezone: \`${TIMEZONE}\`)

📌 *Task Management Commands:*
• \`/add <time> <Task Name>\` — Schedule a one-time reminder
  _Example:_ \`/add 19:30 Study Spring Boot\`
• \`/add <time> <Task Name> daily\` — Schedule a recurring daily reminder
  _Example:_ \`/add 17:30 ចូលរៀន RUPP daily\`
• \`/list\` — View all tasks & statuses
• \`/done <id>\` — Mark a task as completed (e.g. \`/done 1\`)
• \`/delete <id>\` — Delete a task (e.g. \`/delete 1\`)

📚 *Weekly Class Schedule Commands:*
• \`/today\` — View today's class schedule instantly
• \`/schedule\` (or \`/timetable\`) — View your full weekly class timetable
• \`/addschedule <DAY> <TIME> <Subject> | <Room>\` — Add a weekly class
• \`/deleteschedule <id>\` — Remove a class schedule

🌐 *Translation & Grammar Assistant:*
• \`/translate <text>\` — Translate Khmer ↔️ English or fix English grammar
  _Example:_ \`/translate ខ្ញុំរៀននៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញ\`
  _Example:_ \`/translate She do not likes apples\`

⚙️ *Utilities:*
• \`/time\` — Check current clock & timezone
• \`/help\` — View this guide

✨ *Automations:*
• 🔔 Reminders with interactive *[✅ Mark as Done]* buttons.
• 🌅 Daily morning briefings & class schedule alerts at *07:00 AM*.`;

  return ctx.replyWithMarkdown(welcomeMessage);
});

// Command: /help
bot.help((ctx) => {
  const helpMessage = 
`📖 *Command Guide:*

📝 *Tasks:*
• \`/add <time> <Task Name>\` — One-time task
• \`/add <time> <Task Name> daily\` — Daily recurring task
• \`/list\` — Display your active tasks
• \`/done <id>\` — Mark task done
• \`/delete <id>\` — Delete task

📚 *Weekly Timetable:*
• \`/today\` — View today's class schedule instantly
• \`/schedule\` — View full weekly timetable
• \`/addschedule <DAY> <TIME> <Subject> | <Room>\`
• \`/deleteschedule <id>\` — Delete a class

🌐 *Language & AI Assistant:*
• \`/translate <text>\` — Translate Khmer ↔️ English or check English grammar
  _(Supports inline buttons for instant translation & grammar check!)_

🕒 *System:*
• \`/time\` — Check server clock and active timezone`;

  return ctx.replyWithMarkdown(helpMessage);
});

// Command: /time (check server time & timezone)
bot.command('time', (ctx) => {
  const currentTime = getCurrentTimeString(TIMEZONE);
  return ctx.replyWithMarkdown(
    `🕒 *Bot Clock:* \`${currentTime}\`\n🌍 *Timezone:* \`${TIMEZONE}\`\n\n_Schedule tasks matching this time!_`
  );
});

// -------------------------------------------------------------
// Tasks Commands
// -------------------------------------------------------------

// Command: /add <time> <Task Description>
bot.command('add', async (ctx) => {
  const messageText = ctx.message.text;
  const payload = messageText.replace(/^\/add(@\w+)?\s*/i, '').trim();

  if (!payload) {
    return ctx.replyWithMarkdown(
      `⚠️ *Missing details!*\n\nPlease specify the time and task name:\n• \`/add 19:30 Study Spring Boot\`\n• \`/add 17:30 ចូលរៀន RUPP daily\``
    );
  }

  // Expect time as the first token (supports "14:30", "2:30 PM", or "2:30pm"), followed by task title
  const match = payload.match(/^(\d{1,2}:\d{2}(?:\s*(?:am|pm))?)\s+(.+)$/is);
  if (!match) {
    return ctx.replyWithMarkdown(
      `⚠️ *Invalid format!*\n\nPlease provide a time and a task description:\n• \`/add 14:30 Study Spring Boot\` (24-hour)\n• \`/add 2:30 PM Study Spring Boot\` (12-hour AM/PM)`
    );
  }

  const rawTime = match[1];
  let rawTitle = match[2].trim();

  // Detect and parse recurring keyword: e.g. "daily", "--daily", or "-d"
  const dailyPattern = /(?:^|\s+)(?:--daily|-d|daily)(?:\s+|$)/i;
  const isRecurring = dailyPattern.test(rawTitle);
  const taskTitle = rawTitle.replace(dailyPattern, ' ').trim();

  if (!taskTitle) {
    return ctx.replyWithMarkdown('⚠️ Please provide a task description along with the time!');
  }

  const validatedTime = parseAndValidateTime(rawTime);
  if (!validatedTime) {
    return ctx.replyWithMarkdown(
      `⚠️ *Invalid time format:* \`${rawTime}\`\n\nPlease use \`HH:mm\` (e.g. \`14:30\` or \`2:30 PM\`).`
    );
  }

  try {
    // Insert into PostgreSQL with is_recurring flag
    const newTask = await createTask(ctx.chat.id, taskTitle, validatedTime, isRecurring);
    const currentTime = getCurrentTimeString(TIMEZONE);
    const time12 = formatTo12Hour(newTask.reminder_time);
    const current12 = formatTo12Hour(currentTime);

    // Dynamic schedule badge
    const scheduleBadge = newTask.is_recurring 
      ? `🔄 *Schedule:* Daily Recurring (Every day)\n` 
      : '';
    const footerText = newTask.is_recurring
      ? `I will ping you every day at \`${newTask.reminder_time}\`! 🔄`
      : `I will ping you here automatically when it's \`${newTask.reminder_time}\`! 🔔`;

    // Warning if user scheduled 01:xx - 11:xx without specifying AM/PM while currently afternoon
    let warning = '';
    const hourNum = parseInt(newTask.reminder_time.split(':')[0], 10);
    const currentHourNum = parseInt(currentTime.split(':')[0], 10);
    if (!rawTime.toLowerCase().includes('am') && !rawTime.toLowerCase().includes('pm') && hourNum < 12 && currentHourNum >= 12) {
      const pmHour = hourNum + 12;
      const minutes = newTask.reminder_time.split(':')[1];
      warning = `\n\n⚠️ *Notice:* You wrote \`${rawTime}\`, which is *${time12}* (early morning!). If you meant this afternoon/evening, use \`${pmHour}:${minutes}\` or \`${rawTime} PM\`.`;
    }

    return ctx.replyWithMarkdown(
      `✅ *Task Scheduled!*

🆔 *Task ID:* \`#${newTask.id}\`
⏰ *Alert Time:* \`${newTask.reminder_time}\` (${time12})
📝 *Task:* *${newTask.task_name}*
${scheduleBadge}🕒 *Current Time:* \`${currentTime}\` (${current12})

${footerText}${warning}`
    );
  } catch (error) {
    console.error('Error saving task to database:', error);
    return ctx.reply('❌ An error occurred while saving your task. Please try again.');
  }
});

// Command: /list
bot.command('list', async (ctx) => {
  try {
    const userTasks = await getTasksByChatId(ctx.chat.id);

    if (userTasks.length === 0) {
      return ctx.replyWithMarkdown(
        `📭 *No tasks found.*\n\nYou have no tasks scheduled. Add one using:\n• \`/add <time> <Task Name>\`\n• \`/add <time> <Task Name> daily\``
      );
    }

    const taskListText = userTasks
      .map((task, index) => {
        let statusBadge = '⏳ Pending';
        if (task.status === 'COMPLETED') {
          statusBadge = '✅ Completed';
        } else if (task.is_notified) {
          statusBadge = '🔔 Notified';
        }

        const recurringBadge = task.is_recurring ? ' [🔄 Daily]' : '';
        const time12 = formatTo12Hour(task.reminder_time);
        return `${index + 1}. [${statusBadge}]${recurringBadge} ⏰ *[${task.reminder_time} / ${time12}]* — ${task.task_name} _(#${task.id})_`;
      })
      .join('\n');

    return ctx.replyWithMarkdown(
      `📋 *Your Tasks (${userTasks.length}):*\n\n${taskListText}\n\n_Quick actions:_ \`/done <id>\` • \`/delete <id>\``
    );
  } catch (error) {
    console.error('Error querying tasks from database:', error);
    return ctx.reply('❌ An error occurred while fetching your tasks. Please try again.');
  }
});

// Command: /done <id> (Manual completion command)
bot.command('done', async (ctx) => {
  const payload = ctx.message.text.replace(/^\/done(@\w+)?\s*/i, '').trim();
  const taskId = parseInt(payload, 10);

  if (isNaN(taskId)) {
    return ctx.replyWithMarkdown('⚠️ Please provide a valid task ID number:\n_Example:_ `/done 1`');
  }

  try {
    const updated = await markTaskAsCompleted(taskId, ctx.chat.id);
    if (!updated) {
      return ctx.replyWithMarkdown(`❌ Task \`#${taskId}\` was not found in your task list.`);
    }

    const recurringNotice = updated.is_recurring ? ' (Repeats again tomorrow! 🔄)' : '';
    return ctx.replyWithMarkdown(`🎉 *Task #${taskId} Marked as Completed!* ("${updated.task_name}")${recurringNotice}`);
  } catch (error) {
    console.error('Error completing task:', error);
    return ctx.reply('❌ Could not complete the task. Please try again.');
  }
});

// Command: /delete <id> (Remove a task)
bot.command('delete', async (ctx) => {
  const payload = ctx.message.text.replace(/^\/delete(@\w+)?\s*/i, '').trim();
  const taskId = parseInt(payload, 10);

  if (isNaN(taskId)) {
    return ctx.replyWithMarkdown('⚠️ Please provide a valid task ID number to delete:\n_Example:_ `/delete 1`');
  }

  try {
    const deleted = await deleteTask(taskId, ctx.chat.id);
    if (!deleted) {
      return ctx.replyWithMarkdown(`❌ Task \`#${taskId}\` was not found in your task list.`);
    }

    return ctx.replyWithMarkdown(`🗑️ *Task #${taskId} Deleted Successfully!* (${deleted.task_name})`);
  } catch (error) {
    console.error('Error deleting task:', error);
    return ctx.reply('❌ Could not delete the task. Please try again.');
  }
});

// Interactive Inline Button Callback Query Handler: "✅ Mark as Done"
bot.action(/^done:(\d+)$/, async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);

  try {
    const updated = await markTaskAsCompleted(taskId, ctx.chat.id);
    await ctx.answerCbQuery('Task completed! Great job! 🎉');

    if (updated) {
      const footerNote = updated.is_recurring
        ? `🎉 <i>Finished for today! It will remind you again tomorrow at ${updated.reminder_time}. 🔄</i>`
        : `🎉 <i>Marked as finished. Keep up the momentum!</i>`;

      const completedMessage = 
`✅ <b>TASK COMPLETED!</b>

<s>📌 <b>Task:</b> ${updated.task_name}</s>
⏱ <b>Scheduled Time:</b> <code>${updated.reminder_time}</code>
🆔 <b>Task ID:</b> <code>#${updated.id}</code>

${footerNote}`;

      await ctx.editMessageText(completedMessage, {
        parse_mode: 'HTML',
      });
    } else {
      await ctx.editMessageReplyMarkup(undefined);
    }
  } catch (err) {
    console.error('Error handling done callback query:', err);
    await ctx.answerCbQuery('Could not complete task.');
  }
});

// -------------------------------------------------------------
// Weekly Class Schedule Commands
// -------------------------------------------------------------

// Command: /addschedule <MON/TUE/WED/THU/FRI> <HH:MM> <Subject> | <Room>
bot.command('addschedule', async (ctx) => {
  const payload = ctx.message.text.replace(/^\/addschedule(@\w+)?\s*/i, '').trim();

  if (!payload) {
    return ctx.replyWithMarkdown(
      `⚠️ *Format:* \`/addschedule <DAY> <TIME> <Subject> | <Room>\`\n\n` +
      `_Example:_ \`/addschedule MON 08:00 System Analysis | Lab 202\`\n` +
      `_Example:_ \`/addschedule TUE 13:30 Software Architecture | Room 301\``
    );
  }

  // Expect: <DAY> <TIME> <Subject | Room>
  const match = payload.match(/^([a-zA-Z]+)\s+(\d{1,2}:\d{2}(?:\s*(?:am|pm))?)\s+(.+)$/is);
  if (!match) {
    return ctx.replyWithMarkdown(
      `⚠️ *Invalid format!*\n\nPlease use: \`/addschedule <DAY> <TIME> <Subject> | <Room>\`\n_Example:_ \`/addschedule MON 08:00 System Analysis | Lab 202\``
    );
  }

  const rawDay = match[1];
  const rawTime = match[2];
  const rest = match[3].trim();

  const validDay = normalizeDayOfWeek(rawDay);
  if (!validDay) {
    return ctx.replyWithMarkdown(
      `⚠️ *Invalid Day:* \`${rawDay}\`\n\nPlease use: \`MON\`, \`TUE\`, \`WED\`, \`THU\`, \`FRI\` (or \`SAT\`, \`SUN\`).`
    );
  }

  const validTime = parseAndValidateTime(rawTime);
  if (!validTime) {
    return ctx.replyWithMarkdown(
      `⚠️ *Invalid Time:* \`${rawTime}\`\n\nPlease use 24-hour \`HH:mm\` (e.g. \`08:00\` or \`13:30\`).`
    );
  }

  let subject = rest;
  let room = 'N/A';

  if (rest.includes('|')) {
    const parts = rest.split('|');
    subject = parts[0].trim();
    room = parts.slice(1).join('|').trim() || 'N/A';
  }

  if (!subject) {
    return ctx.replyWithMarkdown('⚠️ Please provide a subject name for the class!');
  }

  try {
    const newClass = await createSchedule(ctx.chat.id, validDay, validTime, subject, room);
    const time12 = formatTo12Hour(newClass.time);

    return ctx.replyWithMarkdown(
      `✅ *Class Added to Weekly Schedule!*

📅 *Day:* \`${newClass.day_of_week}\` (${getDayName(newClass.day_of_week)})
⏰ *Time:* \`${newClass.time}\` (${time12})
📖 *Subject:* *${newClass.subject}*
📍 *Room:* \`${newClass.room}\`
🆔 *Schedule ID:* \`#${newClass.id}\`

_Check your full timetable with:_ \`/schedule\``
    );
  } catch (err) {
    console.error('Error adding class schedule:', err);
    return ctx.reply('❌ An error occurred while saving the class schedule.');
  }
});

// Command: /schedule & /timetable (View full weekly schedule)
const handleViewSchedule = async (ctx) => {
  try {
    const classes = await getSchedulesByChatId(ctx.chat.id);

    if (classes.length === 0) {
      return ctx.replyWithMarkdown(
        `📅 *Your Weekly Class Schedule is Empty.*\n\nAdd your classes using:\n\`/addschedule MON 08:00 System Analysis | Lab 202\``
      );
    }

    const daysOrder = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const grouped = {};
    for (const c of classes) {
      if (!grouped[c.day_of_week]) grouped[c.day_of_week] = [];
      grouped[c.day_of_week].push(c);
    }

    let message = `📅 <b>Your Weekly Class Timetable (${classes.length} classes):</b>\n\n`;

    for (const day of daysOrder) {
      if (grouped[day] && grouped[day].length > 0) {
        message += `📚 <b>${getDayName(day).toUpperCase()}:</b>\n`;
        for (const c of grouped[day]) {
          const time12 = formatTo12Hour(c.time);
          message += `  • ⏰ <code>${c.time}</code> (${time12}) — <b>${c.subject}</b> (Room: <code>${c.room || 'N/A'}</code>) <i>[#${c.id}]</i>\n`;
        }
        message += '\n';
      }
    }

    message += `<i>Manage:</i> <code>/addschedule</code> • <code>/deleteschedule &lt;id&gt;</code>`;

    return ctx.replyWithHTML(message);
  } catch (err) {
    console.error('Error querying schedules:', err);
    return ctx.reply('❌ An error occurred while fetching your class schedule.');
  }
};

bot.command('schedule', handleViewSchedule);
bot.command('timetable', handleViewSchedule);

// Command: /today (View today's class schedule instantly)
bot.command('today', async (ctx) => {
  try {
    const targetTz = process.env.TIMEZONE || 'Asia/Phnom_Penh';
    const todayDay = getCurrentDayOfWeek(targetTz);
    const dayName = getDayName(todayDay);
    const currentTime = getCurrentTimeString(targetTz);
    const current12 = formatTo12Hour(currentTime);

    const classes = await getTodaySchedulesByChatId(ctx.chat.id, todayDay);

    if (!classes || classes.length === 0) {
      return ctx.replyWithHTML(
        `🎉 <b>No classes scheduled for today (${dayName})!</b>\n\n` +
        `Enjoy your break and free time! 🌴🏖️\n\n` +
        `<i>View your full weekly timetable with:</i> /schedule`
      );
    }

    const classListText = classes
      .map((c, idx) => {
        const time12 = formatTo12Hour(c.time);
        return `${idx + 1}. ⏰ <code>[${c.time} / ${time12}]</code> — <b>${c.subject}</b>\n   📍 Room: <code>${c.room || 'N/A'}</code>`;
      })
      .join('\n\n');

    const message = 
`📚 <b>Today's Class Schedule (${dayName}):</b>
🕒 <i>Current Time: ${currentTime} (${current12})</i>

You have <b>${classes.length}</b> class(es) today:

${classListText}

<i>Stay focused and have a productive day!</i> 🎓`;

    return ctx.replyWithHTML(message);
  } catch (err) {
    console.error('Error fetching today\'s schedule:', err);
    return ctx.reply('❌ An error occurred while fetching today\'s schedule.');
  }
});

// Command: /deleteschedule <id>
bot.command('deleteschedule', async (ctx) => {
  const payload = ctx.message.text.replace(/^\/deleteschedule(@\w+)?\s*/i, '').trim();
  const scheduleId = parseInt(payload, 10);

  if (isNaN(scheduleId)) {
    return ctx.replyWithMarkdown('⚠️ Please provide a valid schedule ID to delete:\n_Example:_ `/deleteschedule 1`');
  }

  try {
    const deleted = await deleteSchedule(scheduleId, ctx.chat.id);
    if (!deleted) {
      return ctx.replyWithMarkdown(`❌ Class schedule \`#${scheduleId}\` was not found in your timetable.`);
    }

    return ctx.replyWithMarkdown(
      `🗑️ *Class Schedule #${scheduleId} Deleted!* ("${deleted.subject}" on ${deleted.day_of_week})`
    );
  } catch (err) {
    console.error('Error deleting schedule item:', err);
    return ctx.reply('❌ An error occurred while deleting the schedule item.');
  }
});

// Command: /seedschedule (Populate official Year 3 CS schedule)
bot.command(['seedschedule', 'seed'], async (ctx) => {
  const csSchedule = [
    { day_of_week: 'MON', time: '17:30', subject: '.NET programming I (Mr. Kheam Hong)', room: 'Lab 205' },
    { day_of_week: 'MON', time: '19:15', subject: 'Front-End Web Dev (Mr. Thou Chamroeun)', room: 'Lab 205' },
    { day_of_week: 'TUE', time: '17:30', subject: 'Front-End Web Dev (Mr. Thou Chamroeun)', room: 'Room 109' },
    { day_of_week: 'TUE', time: '19:15', subject: 'Applied Statistics (Dr. Chor Chandara)', room: 'Room 109' },
    { day_of_week: 'WED', time: '17:30', subject: 'Information System Analysis (Mr. Ear Eksanthan)', room: 'Room 107' },
    { day_of_week: 'WED', time: '19:15', subject: 'Applied Statistics (Dr. Chor Chandara)', room: 'Room 107' },
    { day_of_week: 'THU', time: '17:30', subject: 'Computer Networks I (Dr. Ouk Khean)', room: 'Room 110' },
    { day_of_week: 'THU', time: '19:15', subject: '.NET programming I (Mr. Kheam Hong)', room: 'Room 110' },
    { day_of_week: 'FRI', time: '17:30', subject: 'Computer Networks I (Dr. Ouk Khean)', room: 'Room 203' },
    { day_of_week: 'FRI', time: '19:15', subject: 'Information System Analysis (Mr. Ear Eksanthan)', room: 'Room 203' },
  ];

  try {
    // Clear old schedules for this chat
    await pool.query('DELETE FROM schedules WHERE chat_id = $1', [ctx.chat.id]);

    for (const item of csSchedule) {
      await createSchedule(ctx.chat.id, item.day_of_week, item.time, item.subject, item.room);
    }

    return ctx.replyWithMarkdown(
      `🎉 *Year 3 CS Semester 1 Schedule Loaded Successfully!* 📚\n\n` +
      `Added all 10 classes (Monday – Friday, 5:30 PM & 7:15 PM).\n\n` +
      `Type \`/schedule\` to view your full weekly timetable!`
    );
  } catch (err) {
    console.error('Error seeding schedule via bot command:', err);
    return ctx.reply('❌ Failed to load schedule.');
  }
});

// -------------------------------------------------------------
// Translation & Grammar Assistant Commands & Callbacks
// -------------------------------------------------------------

// Command: /translate <text> (also aliased to /tr)
bot.command(['translate', 'tr'], async (ctx) => {
  const messageText = ctx.message.text;
  let payload = messageText.replace(/^\/(?:translate|tr)(?:@\w+)?\s*/i, '').trim();

  // If no payload provided directly, check if user replied to another message
  if (!payload && ctx.message.reply_to_message?.text) {
    payload = ctx.message.reply_to_message.text.trim();
  }

  if (!payload) {
    return ctx.replyWithHTML(
      `🌐 <b>Translation & Grammar Assistant</b>\n\n` +
      `<b>របៀបប្រើប្រាស់ (How to use):</b>\n` +
      `• <code>/translate &lt;អត្ថបទរបស់អ្នក&gt;</code>\n\n` +
      `<b>ឧទាហរណ៍ (Examples):</b>\n` +
      `• <code>/translate ខ្ញុំរៀននៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញ</code>\n` +
      `• <code>/translate She do not likes apples yesterday</code>\n\n` +
      `<i>Tip: You can also reply to any message with <code>/translate</code>!</i>`
    );
  }

  // Safety truncation for extremely long messages
  if (payload.length > 2000) {
    payload = payload.slice(0, 2000);
  }

  const sessionId = saveTranslationSession(payload, ctx.chat.id);

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🇰🇭 ➡️ 🇬🇧 Translate to English', `tr:km_en:${sessionId}`)],
    [Markup.button.callback('🇬🇧 ➡️ 🇰🇭 Translate to Khmer', `tr:en_km:${sessionId}`)],
    [Markup.button.callback('✨ Fix English Grammar', `tr:grammar:${sessionId}`)],
  ]);

  return ctx.replyWithHTML(
    `🌐 <b>Translation & Grammar Assistant</b>\n\n` +
    `📝 <b>Input Text:</b>\n<code>${escapeHtml(payload)}</code>\n\n` +
    `<i>Choose an action below:</i>`,
    inlineKeyboard
  );
});

// Callback 1: 🇰🇭 ➡️ 🇬🇧 Translate to English
bot.action(/^tr:km_en:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const text = getTranslationText(sessionId, ctx);

  if (!text) {
    await ctx.answerCbQuery('⚠️ Session expired. Please send /translate again.');
    return ctx.reply('⚠️ This translation request expired. Please type `/translate <text>` again.');
  }

  await ctx.answerCbQuery('Translating to English... 🇬🇧');

  try {
    const result = await translateKhmerToEnglish(text);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✨ Fix English Grammar', `tr:grammar:${sessionId}`),
        Markup.button.callback('🇬🇧 ➡️ 🇰🇭 Translate to Khmer', `tr:en_km:${sessionId}`),
      ],
    ]);

    const replyMessage = 
`🌐 <b>Khmer ➡️ English Translation</b>

🇰🇭 <b>Original (Khmer):</b>
<code>${escapeHtml(text)}</code>

🇬🇧 <b>English Translation:</b>
<b>${escapeHtml(result.text)}</b>

<i>(Powered by ${result.provider})</i>`;

    try {
      await ctx.editMessageText(replyMessage, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (editErr) {
      if (!editErr.message?.includes('message is not modified')) {
        throw editErr;
      }
    }
  } catch (err) {
    console.error('Error translating to English:', err);
    await ctx.reply('❌ Translation failed. Please try again.');
  }
});

// Callback 2: 🇬🇧 ➡️ 🇰🇭 Translate to Khmer
bot.action(/^tr:en_km:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const text = getTranslationText(sessionId, ctx);

  if (!text) {
    await ctx.answerCbQuery('⚠️ Session expired. Please send /translate again.');
    return ctx.reply('⚠️ This translation request expired. Please type `/translate <text>` again.');
  }

  await ctx.answerCbQuery('Translating to Khmer... 🇰🇭');

  try {
    const result = await translateEnglishToKhmer(text);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✨ Fix English Grammar', `tr:grammar:${sessionId}`),
        Markup.button.callback('🇰🇭 ➡️ 🇬🇧 Translate to English', `tr:km_en:${sessionId}`),
      ],
    ]);

    const replyMessage = 
`🌐 <b>English ➡️ Khmer Translation</b>

🇬🇧 <b>Original (English):</b>
<code>${escapeHtml(text)}</code>

🇰🇭 <b>Khmer Translation:</b>
<b>${escapeHtml(result.text)}</b>

<i>(Powered by ${result.provider})</i>`;

    try {
      await ctx.editMessageText(replyMessage, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (editErr) {
      if (!editErr.message?.includes('message is not modified')) {
        throw editErr;
      }
    }
  } catch (err) {
    console.error('Error translating to Khmer:', err);
    await ctx.reply('❌ Translation failed. Please try again.');
  }
});

// Callback 3: ✨ Fix English Grammar
bot.action(/^tr:grammar:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const text = getTranslationText(sessionId, ctx);

  if (!text) {
    await ctx.answerCbQuery('⚠️ Session expired. Please send /translate again.');
    return ctx.reply('⚠️ This translation request expired. Please type `/translate <text>` again.');
  }

  await ctx.answerCbQuery('Analyzing grammar with AI... ✨');

  try {
    const result = await fixEnglishGrammar(text);

    if (!result.hasKey) {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🇰🇭 ➡️ 🇬🇧 Translate to English', `tr:km_en:${sessionId}`),
          Markup.button.callback('🇬🇧 ➡️ 🇰🇭 Translate to Khmer', `tr:en_km:${sessionId}`),
        ],
      ]);

      const warningMessage = 
`✨ <b>English Grammar Assistant</b>

📝 <b>Input Text:</b>
<code>${escapeHtml(text)}</code>

⚠️ <b>AI API Key Required for Grammar Analysis</b>

To enable AI grammar correction and explanations:
1. Get a <b>free</b> Gemini API key from <a href="https://aistudio.google.com/">Google AI Studio</a>
2. Add <code>GEMINI_API_KEY=your_key</code> in your <code>.env</code> file
3. Restart your bot!

<i>(Basic Khmer ↔️ English translations work right now via Google Translate!)</i>`;

      return await ctx.editMessageText(warningMessage, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🇬🇧 ➡️ 🇰🇭 Translate to Khmer', `tr:en_km:${sessionId}`)],
    ]);

    const replyMessage = 
`✨ <b>English Grammar Correction & Analysis</b>

❌ <b>Original Text:</b>
<code>${escapeHtml(text)}</code>

✅ <b>Corrected English:</b>
<b>${escapeHtml(result.corrected)}</b>

💡 <b>Explanation & Tips:</b>
${escapeHtml(result.explanation)}

<i>(Analyzed with ${result.provider})</i>`;

    try {
      await ctx.editMessageText(replyMessage, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (editErr) {
      if (!editErr.message?.includes('message is not modified')) {
        throw editErr;
      }
    }
  } catch (err) {
    console.error('Error analyzing grammar:', err);
    await ctx.reply(`❌ Grammar analysis failed: ${err.message || 'Please verify your GEMINI_API_KEY in .env.'}`);
  }
});

// -------------------------------------------------------------
// Application Lifecycle & Schedulers
// -------------------------------------------------------------

// Reference to background cron manager for graceful teardown
let cronManager = null;

// Helper: Resilient launch with automatic retry for transient network hiccups
async function launchBotWithRetry(targetBot, retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await targetBot.launch();
      console.log('🤖 Telegram Bot polling started successfully.');

      // Automatically sync bot commands with Telegram's menu button
      await targetBot.telegram.setMyCommands([
        { command: 'start', description: 'ចាប់ផ្ដើមប្រើប្រាស់ Bot' },
        { command: 'today', description: 'មើលកាលវិភាគថ្ងៃនេះ (Today classes)' },
        { command: 'schedule', description: 'មើលកាលវិភាគសប្ដាហ៍ (Weekly Timetable)' },
        { command: 'translate', description: 'បកប្រែ & កែវេយ្យាករណ៍ (Translate & Grammar)' },
        { command: 'add', description: 'បន្ថែម Task ថ្មី (ឧ. /add 19:30 រៀនកូដ daily)' },
        { command: 'list', description: 'មើលបញ្ជី Task ទាំងអស់' },
        { command: 'addschedule', description: 'បញ្ចូលកាលវិភាគ (ឧ. /addschedule MON 08:00...)' },
        { command: 'deleteschedule', description: 'លុបកាលវិភាគ (ឧ. /deleteschedule 1)' },
        { command: 'seedschedule', description: 'បញ្ចូលកាលវិភាគឆ្នាំទី៣ CS ដោយស្វ័យប្រវត្តិ' },
        { command: 'done', description: 'សម្គាល់ Task ថាបានរួចរាល់ (ឧ. /done 1)' },
        { command: 'delete', description: 'លុប Task ចោល (ឧ. /delete 1)' },
        { command: 'time', description: 'ពិនិត្យម៉ោង និង Timezone' },
        { command: 'help', description: 'មើលការណែនាំពីរបៀបប្រើ' },
      ]).catch((err) => console.warn('⚠️ Could not auto-sync menu commands:', err.message));

      return;
    } catch (err) {
      console.warn(`⚠️ Telegram connection attempt ${attempt}/${retries} failed (${err.code || err.message}). Retrying in ${delayMs / 1000}s...`);
      if (attempt === retries) {
        console.error('❌ Could not connect to Telegram API after multiple attempts.');
        console.error('💡 Hint: Your ISP or network may be resetting connections to api.telegram.org.');
        console.error('👉 Tip: Turn on Cloudflare WARP (1.1.1.1) or a VPN on your PC to bypass ISP blocking.');
      } else {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
}

// -------------------------------------------------------------
// Render Web Service HTTP Health-Check Server
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        message: '🤖 Telegram Task & Reminder Bot is running successfully!',
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        timezone: TIMEZONE,
      })
    );
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Bootstrap application: start HTTP server immediately for Render port scan, connect DB, start scheduler & launch bot
async function startApp() {
  try {
    // 1. Start HTTP server immediately on 0.0.0.0 to satisfy Render's port detection
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 HTTP health-check server listening on 0.0.0.0:${PORT} (Render compatible)`);
    });

    // 2. Initialize DB and verify table schema & indexes
    await initDb();

    // 3. Start background reminder, class alerts & morning briefing cron workers
    cronManager = startScheduler(bot);

    // 4. Launch Telegram Bot polling with resilient retry
    launchBotWithRetry(bot);

    console.log('🤖 Telegram Bot is up and running with PostgreSQL persistence!');
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

startApp();

// Graceful shutdown handling
const shutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Gracefully stopping bot, HTTP server, schedulers, and database pool...`);
  if (cronManager) cronManager.stop();
  bot.stop(signal);
  server.close(() => {
    console.log('🌐 HTTP server closed.');
  });
  await pool.end();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

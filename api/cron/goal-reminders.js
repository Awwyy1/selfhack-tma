import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  // Verify cron secret (from external cron service or direct call)
  const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return res.status(500).json({ error: 'Bot token not configured' });
  }

  try {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Find active goals created more than 3 days ago that haven't had a reminder sent
    const { data: goals, error: goalsError } = await supabase
      .from('goals')
      .select('id, telegram_user_id, text, created_at')
      .is('status', null) // active goals (status is null or 'active')
      .or('status.eq.active')
      .lte('created_at', threeDaysAgo)
      .is('goal_reminder_sent', null); // hasn't received reminder yet

    if (goalsError) throw goalsError;

    if (!goals || goals.length === 0) {
      return res.status(200).json({ message: 'No goals need reminders', sent: 0 });
    }

    // Get unique user IDs
    const userIds = [...new Set(goals.map(g => g.telegram_user_id))];

    // Get last_seen for these users
    const { data: preferences, error: prefError } = await supabase
      .from('user_preferences')
      .select('telegram_user_id, last_seen')
      .in('telegram_user_id', userIds);

    if (prefError) throw prefError;

    // Create a map of user_id -> last_seen
    const lastSeenMap = {};
    if (preferences) {
      preferences.forEach(p => {
        lastSeenMap[p.telegram_user_id] = p.last_seen;
      });
    }

    let sentCount = 0;
    const errors = [];

    for (const goal of goals) {
      const lastSeen = lastSeenMap[goal.telegram_user_id];

      // Skip if user was seen within the last 3 days
      if (lastSeen && new Date(lastSeen) > new Date(threeDaysAgo)) {
        continue;
      }

      try {
        // Truncate goal text if too long
        const goalText = goal.text.length > 50
          ? goal.text.substring(0, 47) + '...'
          : goal.text;

        // Send Telegram message
        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: goal.telegram_user_id,
              text: `Привет! Как продвигается твоя цель?\n\n"${goalText}"\n\nЗаходи в SelfHack, чтобы обсудить прогресс с коучем.`,
              parse_mode: 'HTML'
            })
          }
        );

        const telegramResult = await telegramResponse.json();

        if (telegramResult.ok) {
          // Mark that reminder was sent for this goal
          await supabase
            .from('goals')
            .update({ goal_reminder_sent: true })
            .eq('id', goal.id);

          sentCount++;
        } else {
          errors.push({
            goal_id: goal.id,
            user_id: goal.telegram_user_id,
            error: telegramResult.description
          });
        }
      } catch (sendError) {
        errors.push({
          goal_id: goal.id,
          user_id: goal.telegram_user_id,
          error: sendError.message
        });
      }
    }

    return res.status(200).json({
      message: `Processed ${goals.length} goals, sent ${sentCount} reminders`,
      sent: sentCount,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error processing goal reminders:', error);
    return res.status(500).json({ error: 'Failed to process goal reminders' });
  }
}

import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  // Verify cron secret (Vercel adds this header for cron jobs)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return res.status(500).json({ error: 'Bot token not configured' });
  }

  try {
    // Get all unsent reminders that are due
    const now = new Date().toISOString();

    const { data: reminders, error: fetchError } = await supabase
      .from('reminders')
      .select('*')
      .eq('sent', false)
      .lte('remind_at', now);

    if (fetchError) throw fetchError;

    if (!reminders || reminders.length === 0) {
      return res.status(200).json({ message: 'No reminders to send', sent: 0 });
    }

    let sentCount = 0;
    const errors = [];

    for (const reminder of reminders) {
      try {
        // Send Telegram message
        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: reminder.telegram_user_id,
              text: `Напоминание от SelfHack:\n\n${reminder.message}`,
              parse_mode: 'HTML'
            })
          }
        );

        const telegramResult = await telegramResponse.json();

        if (telegramResult.ok) {
          // Mark reminder as sent
          await supabase
            .from('reminders')
            .update({ sent: true })
            .eq('id', reminder.id);

          sentCount++;
        } else {
          errors.push({
            reminder_id: reminder.id,
            error: telegramResult.description
          });
        }
      } catch (sendError) {
        errors.push({
          reminder_id: reminder.id,
          error: sendError.message
        });
      }
    }

    return res.status(200).json({
      message: `Processed ${reminders.length} reminders`,
      sent: sentCount,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error processing reminders:', error);
    return res.status(500).json({ error: 'Failed to process reminders' });
  }
}

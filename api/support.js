import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_id, username, message } = req.body;

  if (!user_id || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { error } = await supabase
      .from('support_messages')
      .insert({
        telegram_user_id: user_id,
        username: username || 'Unknown',
        message: message.trim()
      });

    if (error) throw error;

    console.log(`✅ Support message from ${username} (${user_id})`);

    return res.status(200).json({ 
      success: true,
      message: 'Сообщение отправлено в поддержку'
    });

  } catch (error) {
    console.error('❌ Support API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Ошибка отправки сообщения'
    });
  }
}

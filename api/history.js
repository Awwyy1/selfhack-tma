import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const { data } = await supabase
      .from('telegram_chats')
      .select('role, content, created_at')
      .eq('telegram_user_id', user_id)
      .order('created_at', { ascending: true })
      .limit(50);

    return res.status(200).json({ 
      history: data || []
    });

  } catch (error) {
    console.error('History API error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}

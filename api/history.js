import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  const { user_id, offset = '0', limit = '50' } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  const offsetNum = parseInt(offset, 10);
  const limitNum = parseInt(limit, 10);

  try {
    // Get total count of messages
    const { count: totalCount } = await supabase
      .from('telegram_chats')
      .select('*', { count: 'exact', head: true })
      .eq('telegram_user_id', user_id);

    // Fetch messages with pagination
    const { data } = await supabase
      .from('telegram_chats')
      .select('id, role, content, created_at')
      .eq('telegram_user_id', user_id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offsetNum, offsetNum + limitNum - 1);

    // Reverse to get chronological order (oldest first) for display
    const history = data ? data.reverse() : [];

    // Check if there are more messages to load
    const hasMore = (offsetNum + limitNum) < totalCount;

    return res.status(200).json({
      history: history,
      totalCount: totalCount || 0,
      hasMore: hasMore
    });

  } catch (error) {
    console.error('History API error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}

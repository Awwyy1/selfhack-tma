import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const userId = req.query.user_id || req.body?.user_id;

  if (!userId) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  // GET - Load user's reminders
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('reminders')
        .select('*')
        .eq('telegram_user_id', userId)
        .eq('status', 'pending')
        .order('remind_at', { ascending: true });

      if (error) throw error;

      return res.status(200).json({ reminders: data || [] });
    } catch (error) {
      console.error('Error loading reminders:', error);
      return res.status(500).json({ error: 'Failed to load reminders' });
    }
  }

  // POST - Create new reminder
  if (req.method === 'POST') {
    try {
      const { message, remind_at } = req.body;

      if (!message || !remind_at) {
        return res.status(400).json({ error: 'message and remind_at are required' });
      }

      const { data, error } = await supabase
        .from('reminders')
        .insert({
          telegram_user_id: userId,
          message: message,
          remind_at: remind_at,
          status: 'pending'
        })
        .select()
        .single();

      if (error) throw error;

      return res.status(200).json({ reminder: data });
    } catch (error) {
      console.error('Error creating reminder:', error);
      return res.status(500).json({ error: 'Failed to create reminder' });
    }
  }

  // DELETE - Remove reminder
  if (req.method === 'DELETE') {
    try {
      const { reminder_id } = req.body;

      if (!reminder_id) {
        return res.status(400).json({ error: 'reminder_id is required' });
      }

      const { error } = await supabase
        .from('reminders')
        .delete()
        .eq('id', reminder_id)
        .eq('telegram_user_id', userId);

      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting reminder:', error);
      return res.status(500).json({ error: 'Failed to delete reminder' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

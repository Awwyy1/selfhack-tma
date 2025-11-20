import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  const { method } = req;

  // GET - Load goals
  if (method === 'GET') {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
      const { data: goals, error } = await supabase
        .from('goals')
        .select('*')
        .eq('telegram_user_id', user_id)
        .order('target_date', { ascending: true, nullsFirst: false });

      if (error) throw error;

      return res.status(200).json({
        success: true,
        goals: goals || []
      });

    } catch (error) {
      console.error('Load goals error:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: 'Error loading goals'
      });
    }
  }

  // POST - Add goal
  if (method === 'POST') {
    const { user_id, text, target_date } = req.body;

    if (!user_id || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const { data: goal, error } = await supabase
        .from('goals')
        .insert({
          telegram_user_id: user_id,
          text: text,
          target_date: target_date || null
        })
        .select()
        .single();

      if (error) throw error;

      console.log(`Goal added for user ${user_id}: ${text}`);

      return res.status(200).json({
        success: true,
        goal: goal
      });

    } catch (error) {
      console.error('Add goal error:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: 'Error adding goal'
      });
    }
  }

  // DELETE - Delete goal
  if (method === 'DELETE') {
    const { user_id, goal_id } = req.body;

    if (!user_id || !goal_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const { error } = await supabase
        .from('goals')
        .delete()
        .eq('id', goal_id)
        .eq('telegram_user_id', user_id);

      if (error) throw error;

      console.log(`Goal ${goal_id} deleted for user ${user_id}`);

      return res.status(200).json({
        success: true
      });

    } catch (error) {
      console.error('Delete goal error:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: 'Error deleting goal'
      });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

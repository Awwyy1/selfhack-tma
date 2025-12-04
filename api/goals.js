import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';

export default async function handler(req, res) {
  const { method } = req;

  // GET - Load goals with subgoals
  if (method === 'GET') {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
      // Load goals
      const { data: goals, error: goalsError } = await supabase
        .from('goals')
        .select('*')
        .eq('telegram_user_id', user_id)
        .order('target_date', { ascending: true, nullsFirst: false });

      if (goalsError) throw goalsError;

      // Load subgoals for all goals
      const goalIds = goals?.map(g => g.id) || [];
      
      let subgoals = [];
      if (goalIds.length > 0) {
        const { data: subgoalsData, error: subgoalsError } = await supabase
          .from('subgoals')
          .select('*')
          .in('goal_id', goalIds)
          .order('sort_order', { ascending: true });

        if (subgoalsError) {
          console.error('Subgoals load error:', subgoalsError);
          // Продолжаем без подцелей если таблица не существует
          subgoals = [];
        } else {
          subgoals = subgoalsData || [];
        }
      }

      // Attach subgoals to their goals
      const goalsWithSubgoals = goals?.map(goal => ({
        ...goal,
        subgoals: subgoals.filter(s => s.goal_id === goal.id)
      })) || [];

      return res.status(200).json({
        success: true,
        goals: goalsWithSubgoals
      });

    } catch (error) {
      console.error('Load goals error:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: 'Error loading goals'
      });
    }
  }

  // POST - Add goal or subgoal
  if (method === 'POST') {
    const { user_id, text, target_date, action, goal_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // Add subgoal
    if (action === 'add-subgoal') {
      if (!goal_id || !text) {
        return res.status(400).json({ error: 'Missing goal_id or text' });
      }

      try {
        // Check subgoal limit (10 max)
        const { count, error: countError } = await supabase
          .from('subgoals')
          .select('*', { count: 'exact', head: true })
          .eq('goal_id', goal_id);

        if (countError) throw countError;

        if (count >= 10) {
          return res.status(400).json({
            success: false,
            message: 'Максимум 10 подцелей на одну цель'
          });
        }

        const { data: subgoal, error } = await supabase
          .from('subgoals')
          .insert({
            goal_id: goal_id,
            telegram_user_id: user_id,
            text: text.trim(),
            sort_order: count || 0
          })
          .select()
          .single();

        if (error) throw error;

        console.log(`Subgoal added for goal ${goal_id}: ${text}`);

        return res.status(200).json({
          success: true,
          subgoal: subgoal
        });

      } catch (error) {
        console.error('Add subgoal error:', error);
        return res.status(500).json({
          error: 'Internal error',
          message: 'Error adding subgoal'
        });
      }
    }

    // Generate subgoals with AI
    if (action === 'generate-subgoals') {
      if (!goal_id || !goal_text) {
        return res.status(400).json({ error: 'Missing goal_id or goal_text' });
      }

      try {
        // Check how many subgoals can be added (max 10)
        const { count: currentCount } = await supabase
          .from('subgoals')
          .select('*', { count: 'exact', head: true })
          .eq('goal_id', goal_id);

        const maxToGenerate = 10 - (currentCount || 0);
        if (maxToGenerate <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Достигнут лимит подцелей'
          });
        }

        const numToGenerate = Math.min(maxToGenerate, 5);

        // Generate with Claude
        const aiResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 500,
          temperature: 0.7,
          system: `Ты помощник по декомпозиции целей. Разбей цель пользователя на ${numToGenerate} конкретных, измеримых подцелей (шагов). 

Правила:
- Каждая подцель должна быть конкретным действием
- Подцели должны быть последовательными шагами к главной цели
- Формулируй кратко, 5-10 слов максимум
- Отвечай ТОЛЬКО JSON массивом строк, без пояснений и markdown

Пример ответа:
["Подцель 1", "Подцель 2", "Подцель 3"]`,
          messages: [
            { role: 'user', content: `Цель: "${goal_text}"` }
          ]
        });

        let subgoalTexts = [];
        try {
          const content = aiResponse.content[0].text.trim();
          // Убрать возможные markdown обёртки
          const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          subgoalTexts = JSON.parse(cleanContent);
          if (!Array.isArray(subgoalTexts)) {
            throw new Error('Not an array');
          }
        } catch (parseError) {
          console.error('Parse AI response error:', parseError, aiResponse.content[0].text);
          return res.status(500).json({
            success: false,
            message: 'Ошибка генерации подцелей'
          });
        }

        // Insert subgoals
        const subgoalsToInsert = subgoalTexts.slice(0, numToGenerate).map((text, i) => ({
          goal_id: goal_id,
          telegram_user_id: user_id,
          text: String(text).trim(),
          sort_order: (currentCount || 0) + i
        }));

        const { data: insertedSubgoals, error: insertError } = await supabase
          .from('subgoals')
          .insert(subgoalsToInsert)
          .select();

        if (insertError) throw insertError;

        console.log(`Generated ${insertedSubgoals.length} subgoals for goal ${goal_id}`);

        return res.status(200).json({
          success: true,
          subgoals: insertedSubgoals
        });

      } catch (error) {
        console.error('Generate subgoals error:', error);
        return res.status(500).json({
          error: 'Internal error',
          message: 'Error generating subgoals'
        });
      }
    }

    // Add regular goal (default action)
    if (!text) {
      return res.status(400).json({ error: 'Missing text' });
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

      // Return goal with empty subgoals array
      goal.subgoals = [];

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

  // PUT - Update goal or subgoal
  if (method === 'PUT') {
    const { user_id, goal_id, subgoal_id, action, status, new_date, text, is_completed } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // Update subgoal
    if (action === 'update-subgoal' || subgoal_id) {
      if (!subgoal_id) {
        return res.status(400).json({ error: 'Missing subgoal_id' });
      }

      try {
        const updateData = {};

        if (text !== undefined && text.trim() !== '') {
          updateData.text = text.trim();
        }

        if (is_completed !== undefined) {
          updateData.is_completed = is_completed;
        }

        if (Object.keys(updateData).length === 0) {
          return res.status(400).json({ error: 'Nothing to update' });
        }

        const { data: subgoal, error } = await supabase
          .from('subgoals')
          .update(updateData)
          .eq('id', subgoal_id)
          .eq('telegram_user_id', user_id)
          .select()
          .single();

        if (error) throw error;

        console.log(`Subgoal ${subgoal_id} updated:`, updateData);

        return res.status(200).json({
          success: true,
          subgoal: subgoal
        });

      } catch (error) {
        console.error('Update subgoal error:', error);
        return res.status(500).json({
          error: 'Internal error',
          message: 'Error updating subgoal'
        });
      }
    }

    // Update goal
    if (!goal_id) {
      return res.status(400).json({ error: 'Missing goal_id' });
    }

    try {
      const updateData = {};

      // Обновление текста
      if (text !== undefined && text.trim() !== '') {
        updateData.text = text.trim();
      }

      // Обновление даты (без смены статуса)
      if (new_date !== undefined && !status) {
        updateData.target_date = new_date;
      }

      // Обновление статуса
      if (status) {
        const validStatuses = ['active', 'achieved', 'extended', 'failed'];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }

        if (status === 'achieved') {
          updateData.status = 'achieved';
          updateData.completed_at = new Date().toISOString();
        } else if (status === 'failed') {
          updateData.status = 'failed';
          updateData.completed_at = new Date().toISOString();
        } else if (status === 'extended' && new_date) {
          updateData.target_date = new_date;
          updateData.status = 'active';
          updateData.was_extended = true;
        } else {
          updateData.status = status;
        }
      }

      // Проверка что есть что обновлять
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const { data: goal, error } = await supabase
        .from('goals')
        .update(updateData)
        .eq('id', goal_id)
        .eq('telegram_user_id', user_id)
        .select()
        .single();

      if (error) throw error;

      // Load subgoals for this goal
      const { data: subgoals } = await supabase
        .from('subgoals')
        .select('*')
        .eq('goal_id', goal_id)
        .order('sort_order', { ascending: true });

      goal.subgoals = subgoals || [];

      console.log(`Goal ${goal_id} updated for user ${user_id}:`, updateData);
      
      return res.status(200).json({
        success: true,
        goal: goal
      });
    } catch (error) {
      console.error('Update goal error:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: 'Error updating goal'
      });
    }
  }

  // DELETE - Delete goal or subgoal
  if (method === 'DELETE') {
    const { user_id, goal_id, subgoal_id, action } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // Delete subgoal
    if (action === 'delete-subgoal' || subgoal_id) {
      if (!subgoal_id) {
        return res.status(400).json({ error: 'Missing subgoal_id' });
      }

      try {
        const { error } = await supabase
          .from('subgoals')
          .delete()
          .eq('id', subgoal_id)
          .eq('telegram_user_id', user_id);

        if (error) throw error;

        console.log(`Subgoal ${subgoal_id} deleted for user ${user_id}`);

        return res.status(200).json({
          success: true
        });

      } catch (error) {
        console.error('Delete subgoal error:', error);
        return res.status(500).json({
          error: 'Internal error',
          message: 'Error deleting subgoal'
        });
      }
    }

    // Delete goal (subgoals will be deleted by CASCADE)
    if (!goal_id) {
      return res.status(400).json({ error: 'Missing goal_id' });
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

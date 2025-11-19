import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Проверить есть ли уже чекин сегодня
    const { data: existingCheckin } = await supabase
      .from('checkins')
      .select('*')
      .eq('telegram_user_id', user_id)
      .eq('checkin_date', today)
      .maybeSingle();

    if (existingCheckin) {
      return res.status(200).json({ 
        success: false,
        message: 'Ты уже сделал чекин сегодня! Увидимся завтра.',
        already_checked: true
      });
    }

    // Создать чекин
    const { error: insertError } = await supabase
      .from('checkins')
      .insert({ telegram_user_id: user_id, checkin_date: today });

    if (insertError) {
      throw insertError;
    }

    // Посчитать streak
    const { data: allCheckins } = await supabase
      .from('checkins')
      .select('checkin_date')
      .eq('telegram_user_id', user_id)
      .order('checkin_date', { ascending: false });

    let streak = 1;
    if (allCheckins && allCheckins.length > 1) {
      for (let i = 0; i < allCheckins.length - 1; i++) {
        const current = new Date(allCheckins[i].checkin_date);
        const next = new Date(allCheckins[i + 1].checkin_date);
        const diffDays = (current - next) / (1000 * 60 * 60 * 24);
        if (diffDays === 1) {
          streak++;
        } else {
          break;
        }
      }
    }

    console.log(`✅ Checkin: user ${user_id}, streak ${streak}`);

    return res.status(200).json({ 
      success: true,
      streak: streak,
      message: streak > 1 
        ? `Чекин выполнен! Твой streak: ${streak} дней подряд.` 
        : 'Чекин выполнен! Начинаем отсчёт streak.'
    });

  } catch (error) {
    console.error('❌ Checkin API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Ошибка при чекине'
    });
  }
}

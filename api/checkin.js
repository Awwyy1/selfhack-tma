// api/checkin.js
// Чекины + Mood трекинг (PRO)
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_id, action = 'checkin', mood, days = 7 } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    // ==================== MOOD: Сохранить настроение ====================
    if (action === 'mood') {
      // Проверить PRO подписку
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan, expires_at, status')
        .eq('telegram_user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();

      const isPro = subscription && 
                    subscription.plan === 'PRO' && 
                    new Date(subscription.expires_at) > new Date();

      if (!isPro) {
        return res.status(403).json({
          success: false,
          message: 'Трекинг настроения доступен только в PRO'
        });
      }

      // Валидация mood (1-5)
      if (!mood || mood < 1 || mood > 5) {
        return res.status(400).json({
          success: false,
          message: 'mood должен быть от 1 до 5'
        });
      }

      const today = new Date().toISOString().split('T')[0];

      // Upsert — обновить или создать
      const { error: moodError } = await supabase
        .from('mood_tracking')
        .upsert({
          telegram_user_id: user_id,
          mood: mood,
          checkin_date: today
        }, {
          onConflict: 'telegram_user_id,checkin_date'
        });

      if (moodError) {
        console.error('❌ Mood save error:', moodError);
        throw moodError;
      }

      const moodEmojis = ['', '😫', '😕', '😐', '🙂', '😄'];
      console.log(`😊 Mood saved: user ${user_id}, mood ${mood} ${moodEmojis[mood]}`);

      return res.status(200).json({
        success: true,
        message: 'Настроение сохранено!',
        mood: mood
      });
    }

    // ==================== MOOD-STATS: Статистика настроения ====================
    if (action === 'mood-stats') {
      // Проверить PRO подписку
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan, expires_at, status')
        .eq('telegram_user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();

      const isPro = subscription && 
                    subscription.plan === 'PRO' && 
                    new Date(subscription.expires_at) > new Date();

      if (!isPro) {
        return res.status(403).json({
          success: false,
          message: 'Статистика настроения доступна только в PRO'
        });
      }

      // Получить mood за последние N дней
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];

      const { data: moodData, error: moodError } = await supabase
        .from('mood_tracking')
        .select('mood, checkin_date')
        .eq('telegram_user_id', user_id)
        .gte('checkin_date', startDateStr)
        .order('checkin_date', { ascending: true });

      if (moodError) {
        throw moodError;
      }

      // Рассчитать статистику
      const moods = moodData || [];
      const totalEntries = moods.length;
      
      let stats = {
        totalEntries: totalEntries,
        days: days,
        averageMood: 0,
        moodCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        trend: 'stable', // improving, declining, stable
        history: moods
      };

      if (totalEntries > 0) {
        // Средний mood
        const sum = moods.reduce((acc, m) => acc + m.mood, 0);
        stats.averageMood = Math.round((sum / totalEntries) * 10) / 10;

        // Подсчёт по каждому уровню
        moods.forEach(m => {
          stats.moodCounts[m.mood]++;
        });

        // Тренд: сравнить первую и вторую половину периода
        if (totalEntries >= 4) {
          const half = Math.floor(totalEntries / 2);
          const firstHalf = moods.slice(0, half);
          const secondHalf = moods.slice(half);
          
          const avgFirst = firstHalf.reduce((a, m) => a + m.mood, 0) / firstHalf.length;
          const avgSecond = secondHalf.reduce((a, m) => a + m.mood, 0) / secondHalf.length;
          
          if (avgSecond - avgFirst >= 0.5) {
            stats.trend = 'improving';
          } else if (avgFirst - avgSecond >= 0.5) {
            stats.trend = 'declining';
          }
        }
      }

      console.log(`📊 Mood stats: user ${user_id}, entries ${totalEntries}, avg ${stats.averageMood}`);

      return res.status(200).json({
        success: true,
        stats: stats
      });
    }

    // ==================== CHECKIN: Обычный чекин ====================
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

    // Проверить есть ли PRO для отображения mood селектора
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('plan, expires_at, status')
      .eq('telegram_user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();

    const isPro = subscription && 
                  subscription.plan === 'PRO' && 
                  new Date(subscription.expires_at) > new Date();

    console.log(`✅ Checkin: user ${user_id}, streak ${streak}, pro ${isPro}`);

    return res.status(200).json({ 
      success: true,
      streak: streak,
      showMoodSelector: isPro,
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

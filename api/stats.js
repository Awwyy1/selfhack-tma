import { supabase } from '../lib/supabase.js';
import { getUserTone } from '../lib/tone-manager.js';

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('telegram_user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();

    const isPremium = subscription && new Date(subscription.expires_at) > new Date();
    const plan = isPremium ? (subscription.plan === 'pro' ? 'PRO' : 'PREMIUM') : 'FREE';

    const { count: userMessages } = await supabase
      .from('telegram_chats')
      .select('*', { count: 'exact', head: true })
      .eq('telegram_user_id', user_id)
      .eq('role', 'user');

    const { data: allMessages } = await supabase
      .from('telegram_chats')
      .select('id')
      .eq('telegram_user_id', user_id);

    const { data: allCheckins } = await supabase
      .from('checkins')
      .select('checkin_date')
      .eq('telegram_user_id', user_id)
      .order('checkin_date', { ascending: false });

    let streak = 0;
    if (allCheckins && allCheckins.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      const lastCheckin = allCheckins[0].checkin_date;
      
      const lastCheckinDate = new Date(lastCheckin);
      const todayDate = new Date(today);
      const diffDays = Math.floor((todayDate - lastCheckinDate) / (1000 * 60 * 60 * 24));
      
      if (diffDays <= 1) {
        streak = 1;
        for (let i = 0; i < allCheckins.length - 1; i++) {
          const current = new Date(allCheckins[i].checkin_date);
          const next = new Date(allCheckins[i + 1].checkin_date);
          const diff = (current - next) / (1000 * 60 * 60 * 24);
          if (diff === 1) {
            streak++;
          } else {
            break;
          }
        }
      }
    }

    const tone = await getUserTone(user_id);

    // Extract all check-in dates for calendar display
    const checkinDates = allCheckins ? allCheckins.map(c => c.checkin_date) : [];

    return res.status(200).json({
      success: true,
      stats: {
        plan: plan,
        messagesUsed: userMessages || 0,
        messagesLimit: 50,
        totalMessages: allMessages?.length || 0,
        streak: streak,
        checkinDates: checkinDates
      },
      tone: tone
    });

  } catch (error) {
    console.error('❌ Stats API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Ошибка при загрузке статистики'
    });
  }
}

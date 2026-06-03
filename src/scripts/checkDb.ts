import { supabase } from '../config/supabase';

async function checkDb() {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name, calendar_feed_token, calendar_connections(provider, status)');
  if (error) {
    console.error('Error:', error);
    return;
  }

  if (data && data.length > 0) {
    console.log(`Found ${data.length} restaurants.`);
    data.forEach((r: any) => {
      const connections = r.calendar_connections || [];
      console.log(`Restaurant: ${r.name}`);
      console.log(`  Feed token:`, r.calendar_feed_token ? 'YES' : 'NO');
      console.log(`  Calendar connections:`, connections.length
        ? connections.map((c: any) => `${c.provider}(${c.status})`).join(', ')
        : 'none');
    });
  } else {
    console.log('No restaurants found.');
  }
}

checkDb();

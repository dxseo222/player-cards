-- Player Cards Discord bot: posts new cards and trades about once a minute.
-- Run after 007_bot.sql, once the bot is deployed (see "Discord bot" in the README). Safe to run again.
-- Supabase only: it needs the pg_cron and pg_net extensions, so the tests don't run this file.
--
-- Every minute the database calls the bot with the random feed key from public.bot_state.
-- The bot hands the key back when it asks what's new, so only this job can make it post.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('player-cards-discord-feed', '* * * * *', $job$
  select net.http_post(
    url := 'https://xqinypchsnkoiezpvqyn.supabase.co/functions/v1/discord-bot',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-feed-key', (select feed_key from public.bot_state where id)),
    body := '{"feed": true}'::jsonb,
    timeout_milliseconds := 25000
  );
$job$);

-- To stop posting everywhere:  select cron.unschedule('player-cards-discord-feed');

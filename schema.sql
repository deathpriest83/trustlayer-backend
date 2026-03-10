-- TrustLayer Supabase schema
create table if not exists ratings (
    id          uuid default gen_random_uuid() primary key,
    handle      text not null,
    user_id     text not null,
    rating      text not null check (rating in ('trust', 'distrust')),
    country     text not null default 'UNKNOWN',
    date        date not null default current_date,
    created_at  timestamptz not null default now()
  );
create unique index if not exists ratings_unique on ratings (handle, user_id, date);
create index if not exists ratings_handle_idx on ratings (handle);
create index if not exists ratings_country_idx on ratings (country);
create index if not exists ratings_created_idx on ratings (created_at);
create table if not exists community_notes (
    id          uuid default gen_random_uuid() primary key,
    note_id     text unique not null,
    handle      text not null,
    tweet_id    text,
    summary     text,
    helpful     integer default 0,
    created_at  timestamptz not null
  );
create index if not exists cn_handle_idx on community_notes (handle);
create index if not exists cn_created_idx on community_notes (created_at);
alter table ratings enable row level security;
alter table community_notes enable row level security;
create policy "public read ratings" on ratings for select using (true);
create policy "users can rate" on ratings for insert with check (true);
create policy "users can update own rating" on ratings for update using (true);
create policy "public read community notes" on community_notes for select using (true);

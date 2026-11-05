-- Simulora, part 2: persistent social state.
--
-- Run this once in the Supabase SQL editor (or `supabase db push`). It is written to
-- be safe on a project that already has tables: everything is `if not exists`, so
-- re-running it never drops data.
--
-- What persists automatically, during normal simulation, with no user interaction:
--   * NPC relationships (directional, one row per viewer/target pair)
--   * NPC memories (shared, personal, relationship, milestones, disagreements)
--   * BBC headline cache
--
-- What is saved ONLY when someone presses SAVE TO SUPABASE in Conversation Logs:
--   * village_conversations and village_conversation_messages
--
-- Row Level Security is on for every table and no policy grants the anon or
-- authenticated role anything: all access goes through the Vercel functions with the
-- service-role key. The browser holds the anon key nowhere.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- relationships
create table if not exists public.village_npc_relationships (
  npc_id           text        not null,
  other_id         text        not null,
  score            integer     not null default 0 check (score between -100 and 100),
  trust            real        not null default 0.30 check (trust between 0 and 1),
  familiarity      real        not null default 0.08 check (familiarity between 0 and 1),
  friendliness     real        not null default 0.40 check (friendliness between 0 and 1),
  affection        real        not null default 0.10 check (affection between 0 and 1),
  dislike          real        not null default 0.00 check (dislike between 0 and 1),
  category         text        not null default 'stranger',
  interactions     integer     not null default 0,
  last_interaction timestamptz not null default now(),
  notes            text,
  updated_at       timestamptz not null default now(),
  primary key (npc_id, other_id)
);

create index if not exists village_rel_npc_idx
  on public.village_npc_relationships (npc_id, updated_at desc);

-- ---------------------------------------------------------------------- memories
create table if not exists public.village_npc_memories (
  id              text        primary key,
  npc_id          text        not null,
  about_npc_id    text,
  kind            text        not null default 'event',
  description     text        not null,
  importance      real        not null default 0.40 check (importance between 0 and 1),
  context         text,
  conversation_id text,
  created_at      timestamptz not null default now()
);

create index if not exists village_mem_npc_idx
  on public.village_npc_memories (npc_id, created_at desc);
create index if not exists village_mem_about_idx
  on public.village_npc_memories (about_npc_id, created_at desc);
create index if not exists village_mem_conv_idx
  on public.village_npc_memories (conversation_id);

-- --------------------------------------------------------- saved transcripts only
create table if not exists public.village_conversations (
  id                   text        primary key,
  initiator_id         text        not null,
  responder_id         text        not null,
  participants         jsonb       not null default '[]'::jsonb,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  message_count        integer     not null default 0,
  outcome              text        not null default 'complete',
  relationship_context jsonb,
  news_refs            jsonb       not null default '[]'::jsonb,
  memories             jsonb       not null default '[]'::jsonb,
  saved_at             timestamptz not null default now(),
  error                text
);

create index if not exists village_conv_saved_idx
  on public.village_conversations (saved_at desc);

create table if not exists public.village_conversation_messages (
  id              text        primary key,
  conversation_id text        not null references public.village_conversations (id) on delete cascade,
  speaker_id      text        not null,
  speaker_name    text        not null,
  text            text        not null,
  created_at      timestamptz not null default now(),
  message_no      integer     not null default 1,
  generated_by    text        not null default 'groq',
  is_closing      boolean     not null default false
);

create index if not exists village_msg_conv_idx
  on public.village_conversation_messages (conversation_id, message_no);

-- ------------------------------------------------------------------- news cache
create table if not exists public.village_news (
  id           text        primary key,
  headline     text        not null,
  summary      text,
  url          text,
  category     text        not null default 'news',
  source       text        not null default 'BBC News',
  published_at timestamptz,
  fetched_at   timestamptz not null default now()
);

create index if not exists village_news_fetched_idx
  on public.village_news (fetched_at desc);

-- ------------------------------------------------------------------ security
alter table public.village_npc_relationships     enable row level security;
alter table public.village_npc_memories          enable row level security;
alter table public.village_conversations         enable row level security;
alter table public.village_conversation_messages enable row level security;
alter table public.village_news                  enable row level security;

-- No policies are created on purpose. With RLS enabled and no policy, anon and
-- authenticated requests read and write nothing, whatever key they hold. The
-- service role bypasses RLS and is the only path the API routes use.
revoke all on public.village_npc_relationships     from anon, authenticated;
revoke all on public.village_npc_memories          from anon, authenticated;
revoke all on public.village_conversations         from anon, authenticated;
revoke all on public.village_conversation_messages from anon, authenticated;
revoke all on public.village_news                  from anon, authenticated;

grant all on public.village_npc_relationships     to service_role;
grant all on public.village_npc_memories          to service_role;
grant all on public.village_conversations         to service_role;
grant all on public.village_conversation_messages to service_role;
grant all on public.village_news                  to service_role;

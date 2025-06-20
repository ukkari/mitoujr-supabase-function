# CLAUDE.md - Supabase Function Project

## Common Development Commands

### Setup and Configuration
```bash
# Install dependencies
npm install

# Update environment variables (secrets)
npx supabase secrets set --env-file ./supabase/functions/.env
```

### Deployment
```bash
# Deploy a specific function
supabase functions deploy today-channels-summary
supabase functions deploy reminder-cron
supabase functions deploy slash-reminder-mentors

# Deploy all functions
supabase functions deploy
```

### Local Development
```bash
# Start Supabase locally
supabase start

# Stop Supabase
supabase stop

# Serve functions locally
supabase functions serve

# Check function logs
supabase functions logs today-channels-summary
```

### Testing
```bash
# Test endpoints locally (examples from main.http)
# Yesterday's text summary
curl "https://ybayntmemramsitrtlem.supabase.co/functions/v1/today-channels-summary"

# Today's text summary in debug mode
curl "https://ybayntmemramsitrtlem.supabase.co/functions/v1/today-channels-summary?forToday=true&debug=true"

# Audio summary
curl "https://ybayntmemramsitrtlem.supabase.co/functions/v1/today-channels-summary?type=audio"

# Audio summary with debug
curl "https://ybayntmemramsitrtlem.supabase.co/functions/v1/today-channels-summary?forToday=false&debug=true&type=audio"
```

## High-Level Architecture Overview

### Project Structure
```
supabase-function/
├── supabase/
│   ├── config.toml                    # Supabase configuration
│   └── functions/
│       ├── _shared/                   # Shared modules
│       │   ├── cors.ts               # CORS headers utility
│       │   ├── mattermost.ts         # Mattermost API client
│       │   ├── supabaseAdmin.ts      # Supabase admin client
│       │   └── supabaseClient.ts     # Supabase client
│       ├── import_map.json           # Deno import mappings
│       ├── reminder-cron/            # Reminder cron function
│       │   └── index.ts
│       ├── slash-reminder-mentors/   # Slash command handler
│       │   └── index.ts
│       └── today-channels-summary/   # Daily summary function
│           ├── index.ts
│           └── tsconfig.json
└── main.http                         # HTTP test requests
```

### Technology Stack
- **Runtime**: Deno (Edge Functions)
- **Framework**: Supabase Edge Functions
- **Language**: TypeScript
- **External Services**: 
  - Mattermost (team communication)
  - OpenAI API (GPT-4 for summaries)
  - Google Cloud TTS (audio generation)
- **Database**: Supabase (PostgreSQL)

### Core Functions

#### 1. **today-channels-summary**
Main function that generates daily channel summaries from Mattermost.

**Features:**
- Fetches public channel posts from previous day (or today)
- Filters channels by activity and restrictions (🈲/🚫 emojis)
- Generates summaries using OpenAI GPT-4
- Supports both text and audio output formats
- Posts summaries back to Mattermost

**Query Parameters:**
- `forToday`: boolean - Generate today's summary instead of yesterday's
- `type`: "text" | "audio" - Output format
- `debug`: boolean - Debug mode (no Mattermost posting)

**Key Components:**
- Time range calculation (JST timezone handling)
- Channel filtering (excludes notification channels)
- Post aggregation with user mentions and reactions
- OpenAI integration for text summarization
- Audio generation via external API with SSE monitoring

#### 2. **reminder-cron**
Automated reminder system for tracking task completion.

**Features:**
- Monitors reminders stored in database
- Checks for "done" reactions on Mattermost posts
- Sends reminders at strategic intervals (7, 5, 3, 2, 1 days before deadline)
- Continues daily reminders after deadline until completed
- Mentions specific mentors who haven't completed tasks

#### 3. **slash-reminder-mentors**
Handler for Mattermost slash commands (functionality not visible in provided files).

### Shared Modules

#### **mattermost.ts**
Mattermost API client providing:
- `getMentors()`: Fetch mentor group members
- `getReactions()`: Get post reactions
- `postReply()`: Post thread replies
- `createPost()`: Create new posts

#### **Environment Variables**
Required environment variables:
- `MATTERMOST_URL`: Mattermost instance URL
- `MATTERMOST_BOT_TOKEN`: Bot authentication token
- `MATTERMOST_MAIN_TEAM`: Team ID
- `MATTERMOST_SUMMARY_CHANNEL`: Channel ID for summaries
- `OPENAI_API_KEY`: OpenAI API key

### Key Design Patterns

1. **Time Zone Handling**: All time calculations properly handle JST timezone conversion
2. **Privacy Controls**: Channels/threads marked with 🈲 or 🚫 are automatically excluded
3. **Debug Mode**: All functions support debug mode for testing without side effects
4. **Error Handling**: Comprehensive error logging and graceful failure handling
5. **Caching**: User name caching to minimize API calls
6. **Modular Architecture**: Shared utilities in `_shared/` directory

### Configuration Notes

- JWT verification is disabled for `today-channels-summary` function (see config.toml)
- Functions use Deno's native modules and ESM imports
- TypeScript configured with strict mode for type safety
- Edge Runtime configured with "oneshot" policy for hot reload during development
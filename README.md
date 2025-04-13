# TMDB Embed Streams Stremio Addon

A Stremio addon that provides movie and TV show streams from multiple embed sources using TMDB API integration.

## Features

- Supports both movies and TV shows
- Multiple streaming sources
- Quality selection (from 360p to 4K when available)
- Subtitle support
- TMDB integration for metadata

## Installation

1. Clone the repository:
```bash
git clone https://github.com/nayifleo1/http-addon.git
cd http-addon
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with your TMDB API key:
```
TMDB_API_KEY="your_api_key_here"
```

4. Start the addon:
```bash
npm start
```

## Environment Variables

- `TMDB_API_KEY`: Your TMDB API key
- `PORT`: Server port (default: 7004)

## Development

The addon is built using:
- Node.js
- Stremio Addon SDK
- TMDB API

## License

MIT 
# Stremio TMDB Embed Addon

A Stremio addon that provides movie and TV show streams from multiple embed sources using TMDB data. This addon integrates with various streaming sources and provides high-quality streams with subtitles when available.

## Features

- Supports both movies and TV shows
- Multiple quality options (from 360p to 4K when available)
- Subtitle support
- Automatic quality detection
- HLS stream support
- TMDB integration for reliable metadata

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/stremio-tmdb-embed.git
cd stremio-tmdb-embed
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with your TMDB API key:
```bash
TMDB_API_KEY=your_tmdb_api_key_here
PORT=7004  # Optional, defaults to 7004
```

4. Start the addon:
```bash
npm start
```

## Environment Variables

- `TMDB_API_KEY`: Your TMDB API key (required)
- `PORT`: Port number for the addon server (optional, defaults to 7004)

## Development

The addon is built using:
- Node.js
- Stremio Addon SDK
- TMDB API
- node-fetch for HTTP requests
- dotenv for environment variable management

## API Endpoints

The addon uses the following APIs:
- TMDB API (`https://api.themoviedb.org/3`) for metadata
- Custom embed API for stream sources

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This addon is for educational purposes only. Please ensure you have the right to access the content in your jurisdiction. 
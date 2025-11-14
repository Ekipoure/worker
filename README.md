# Server Monitor

A comprehensive server monitoring system built with TypeScript and PostgreSQL that monitors various types of servers and services.

## Features

- **Multiple Monitoring Types**: HTTP, HTTPS, TCP, UDP, and Ping monitoring
- **Real-time Monitoring**: Continuous monitoring with configurable intervals
- **Database Storage**: PostgreSQL database for storing monitoring data and statistics
- **Iran Timezone Support**: Built-in support for Iran timezone (Asia/Tehran)
- **Server Grouping**: Organize servers by groups (Iranian, Global, etc.)
- **Statistics Dashboard**: Real-time statistics and performance metrics
- **Graceful Shutdown**: Proper cleanup on application termination

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL database
- TypeScript (installed via npm)

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your PostgreSQL database and update the connection string in `server-monitor.ts`

4. (Optional) Set up sample servers:
   ```bash
   npm run setup
   ```

## Configuration

### Database Configuration

Update the `DB_CONFIG` object in `server-monitor.ts` with your PostgreSQL connection details:

```typescript
const DB_CONFIG = {
  connectionString: 'postgresql://username:password@host:port/database?sslmode=require'
};
```

### Server Configuration

Servers are stored in the `servers` table with the following structure:

- `name`: Server display name
- `ip_address`: Server IP address or domain name
- `port`: Port number (optional for ping)
- `request_type`: Type of check ('tcp', 'udp', 'http', 'https', 'ping')
- `endpoint`: Custom endpoint URL (optional)
- `expected_status_code`: Expected HTTP status code (for HTTP/HTTPS)
- `server_group`: Server group ('iranian', 'global', etc.)
- `color`: Display color (hex code)
- `check_interval`: Check interval in seconds
- `timeout`: Request timeout in milliseconds
- `is_active`: Whether the server is actively monitored

## Usage

### Start Monitoring

```bash
npm start
```

### Development Mode (with auto-restart)

```bash
npm run dev
```

### Build TypeScript

```bash
npm run build
```

## Monitoring Types

### HTTP/HTTPS Monitoring
- Monitors web servers and APIs
- Checks response status codes
- Measures response time and size
- Captures response headers and body (limited)

### TCP Monitoring
- Tests TCP port connectivity
- Measures connection time
- Useful for database servers, custom services

### UDP Monitoring
- Tests UDP port connectivity using nmap
- Uses `sudo nmap -sU -p <port> --reason --stats-every 1s <ip>` command
- Measures response time from nmap output
- Detects port states: open, closed, filtered, open|filtered
- Useful for DNS servers, game servers, and UDP-based services
- Note: Requires sudo privileges for nmap UDP scanning

### Ping Monitoring
- Uses system ping command
- Tests basic network connectivity
- Measures round-trip time

## Database Schema

### Servers Table
```sql
CREATE TABLE servers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  ip_address INET NOT NULL,
  port INTEGER,
  request_type VARCHAR(10) NOT NULL,
  endpoint VARCHAR(500),
  expected_status_code INTEGER DEFAULT 200,
  server_group VARCHAR(100) DEFAULT 'Default',
  color VARCHAR(7) DEFAULT '#00ff00',
  check_interval INTEGER DEFAULT 60,
  timeout INTEGER DEFAULT 5000,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Monitoring Data Table
```sql
CREATE TABLE monitoring_data (
  id SERIAL PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id),
  response_time DECIMAL(10,2) NOT NULL,
  is_success BOOLEAN NOT NULL,
  status_code INTEGER,
  response_size INTEGER,
  response_headers JSONB,
  response_body TEXT,
  error_message TEXT,
  checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Statistics

The system provides real-time statistics including:

- Total checks performed
- Success rate percentage
- Average response time
- Minimum and maximum response times
- Last check timestamp

Statistics are displayed every 5 minutes and can be viewed in the console output.

## Error Handling

The system handles various error conditions:

- Connection timeouts
- Network errors
- Invalid responses
- Database connection issues
- Graceful shutdown on SIGINT/SIGTERM

## Timezone Support

All timestamps are stored and displayed in Iran timezone (Asia/Tehran) for better local monitoring experience.

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues and questions, please create an issue in the repository or contact the maintainer.

#!/usr/bin/env ts-node

import { Client } from 'pg';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { promisify } from 'util';
import moment from 'moment-timezone';

// Database configuration
const DB_CONFIG = {
  connectionString: 'postgresql://neondb_owner:npg_6VrBJeTUgRj4@ep-solitary-meadow-ad8vsnhd-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
};

// Timezone configuration
const IRAN_TIMEZONE = 'Asia/Tehran';

// Helper function to get Iran timezone aware date
function getIranDate(): Date {
  return moment().tz(IRAN_TIMEZONE).toDate();
}

// Helper function to format date for display in Iran timezone
function formatIranDate(date: Date): string {
  return moment(date).tz(IRAN_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
}

// Types
interface Server {
  id: number;
  name: string;
  ip_address: string;
  port?: number; // Made optional
  request_type: 'tcp' | 'http' | 'https' | 'ping';
  endpoint?: string;
  expected_status_code?: number;
  check_interval: number; // in seconds
  timeout: number; // in milliseconds
  server_group: 'iranian' | 'global';
  color?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ResponseData {
  server_id: number;
  response_time: number; // in milliseconds
  status_code?: number;
  response_size?: number;
  is_success: boolean;
  error_message?: string;
  response_headers?: Record<string, string>;
  response_body?: string;
  source_ip?: string;
  checked_at: Date;
}

class ServerMonitor {
  private dbClient: Client;
  private activeChecks: Map<number, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private checkingServers: Set<number> = new Set(); // جلوگیری از چک همزمان یک سرور

  constructor() {
    this.dbClient = new Client(DB_CONFIG);
  }

  // Function to get the source IP address of the current VPS
  private async getSourceIP(): Promise<string> {
    try {
      // Try to get external IP using a public service
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      // Use multiple methods to get the external IP
      const commands = [
        'curl -s ifconfig.me',
        'curl -s ipinfo.io/ip',
        'curl -s icanhazip.com',
        'curl -s ipecho.net/plain',
        'wget -qO- ifconfig.me'
      ];
      
      for (const command of commands) {
        try {
          const { stdout } = await execAsync(command);
          const ip = stdout.trim();
          // Validate IP address format
          if (this.isValidIP(ip)) {
            return ip;
          }
        } catch (error) {
          // Continue to next command if this one fails
          continue;
        }
      }
      
      // Fallback: try to get local network IP
      const os = require('os');
      const networkInterfaces = os.networkInterfaces();
      
      for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            return iface.address;
          }
        }
      }
      
      return 'unknown';
    } catch (error) {
      console.warn('⚠️  Could not determine source IP:', error);
      return 'unknown';
    }
  }

  // Helper function to validate IP address format
  private isValidIP(ip: string): boolean {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipRegex.test(ip);
  }

  async initialize(): Promise<void> {
    try {
      await this.dbClient.connect();
      
      // Set timezone to Iran
      await this.dbClient.query(`SET timezone = '${IRAN_TIMEZONE}'`);
      
      // Create tables if they don't exist
      await this.createTables();
      
      console.log('✅ Connected to PostgreSQL database with Iran timezone');
    } catch (error) {
      console.error('❌ Failed to initialize:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    try {
      // Create servers table
      await this.dbClient.query(`
        CREATE TABLE IF NOT EXISTS servers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          ip_address INET NOT NULL,
          port INTEGER,
          request_type VARCHAR(10) NOT NULL CHECK (request_type IN ('tcp', 'http', 'https', 'ping')),
          endpoint VARCHAR(500),
          expected_status_code INTEGER DEFAULT 200,
          server_group VARCHAR(100) DEFAULT 'Default',
          color VARCHAR(7) DEFAULT '#00ff00',
          check_interval INTEGER DEFAULT 60,
          timeout INTEGER DEFAULT 5000,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Create monitoring_data table
      await this.dbClient.query(`
        CREATE TABLE IF NOT EXISTS monitoring_data (
          id SERIAL PRIMARY KEY,
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'up',
          response_time DECIMAL(10,2) NOT NULL,
          is_success BOOLEAN NOT NULL,
          status_code INTEGER,
          response_size INTEGER,
          response_headers JSONB,
          response_body TEXT,
          error_message TEXT,
          source_ip INET,
          checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Add missing columns to existing table if they don't exist
      await this.dbClient.query(`
        ALTER TABLE monitoring_data 
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'up';
      `);
      
      await this.dbClient.query(`
        ALTER TABLE monitoring_data 
        ADD COLUMN IF NOT EXISTS response_size INTEGER;
      `);
      
      await this.dbClient.query(`
        ALTER TABLE monitoring_data 
        ADD COLUMN IF NOT EXISTS response_headers JSONB;
      `);
      
      await this.dbClient.query(`
        ALTER TABLE monitoring_data 
        ADD COLUMN IF NOT EXISTS response_body TEXT;
      `);
      
      await this.dbClient.query(`
        ALTER TABLE monitoring_data 
        ADD COLUMN IF NOT EXISTS source_ip INET;
      `);

      // Fix servers table schema issues
      await this.dbClient.query(`
        ALTER TABLE servers 
        ADD COLUMN IF NOT EXISTS expected_status_code INTEGER DEFAULT 200;
      `);
      
      await this.dbClient.query(`
        ALTER TABLE servers 
        ADD COLUMN IF NOT EXISTS server_group VARCHAR(100) DEFAULT 'Default';
      `);

      // Make port nullable for ping requests
      await this.dbClient.query(`
        ALTER TABLE servers 
        ALTER COLUMN port DROP NOT NULL;
      `);

      // Create indexes for better performance
      await this.dbClient.query(`
        CREATE INDEX IF NOT EXISTS idx_monitoring_data_server_id ON monitoring_data(server_id);
      `);
      
      await this.dbClient.query(`
        CREATE INDEX IF NOT EXISTS idx_monitoring_data_checked_at ON monitoring_data(checked_at);
      `);

      await this.dbClient.query(`
        CREATE INDEX IF NOT EXISTS idx_monitoring_data_server_checked ON monitoring_data(server_id, checked_at);
      `);

      console.log('✅ Database tables created/verified successfully');
    } catch (error) {
      console.error('❌ Failed to create tables:', error);
      throw error;
    }
  }

  async startMonitoring(): Promise<void> {
    this.isRunning = true;
    console.log('🚀 Starting server monitoring...');

    // Load active servers and start monitoring
    await this.loadAndStartMonitoring();

    console.log('✅ Server monitoring started. Press Ctrl+C to stop.');
  }

  private async loadAndStartMonitoring(): Promise<void> {
    try {
      const result = await this.dbClient.query(`
        SELECT * FROM servers WHERE is_active = true ORDER BY id
      `);

      const servers: Server[] = result.rows;

      for (const server of servers) {
        // Clear existing interval for this server
        const existingInterval = this.activeChecks.get(server.id);
        if (existingInterval) {
          clearInterval(existingInterval);
        }

        // Start new monitoring for this server
        const interval = setInterval(async () => {
          await this.checkServer(server);
        }, server.check_interval * 1000);

        this.activeChecks.set(server.id, interval);

        // Run initial check immediately (async without await to avoid blocking)
        // This ensures intervals are set up quickly
        this.checkServer(server).catch(err => {
          console.error(`❌ Error in initial check for ${server.name}:`, err);
        });
      }

      console.log(`📊 Monitoring ${servers.length} active servers`);
    } catch (error) {
      console.error('❌ Error loading servers:', error);
    }
  }

  private async checkServer(server: Server): Promise<void> {
    // جلوگیری از چک همزمان: اگر این سرور در حال چک شدن است، skip کن
    if (this.checkingServers.has(server.id)) {
      return;
    }

    // علامت بزن که این سرور در حال چک شدن است
    this.checkingServers.add(server.id);

    const startTime = Date.now();
    let responseData: ResponseData;

    try {
      // Get source IP for this check
      const sourceIP = await this.getSourceIP();

      switch (server.request_type) {
        case 'http':
        case 'https':
          responseData = await this.checkHttpServer(server, startTime, sourceIP);
          break;
        case 'tcp':
          responseData = await this.checkTcpServer(server, startTime, sourceIP);
          break;
        case 'ping':
          responseData = await this.checkPingServer(server, startTime, sourceIP);
          break;
        default:
          throw new Error(`Unsupported request type: ${server.request_type}`);
      }

      // Store response in database
      await this.storeResponse(responseData);

      // Log result
      const status = responseData.is_success ? '✅' : '❌';
      const responseTime = responseData.response_time.toFixed(2);
      const address = server.port ? `${server.ip_address}:${server.port}` : server.ip_address;
      const errorInfo = responseData.error_message ? ` - ${responseData.error_message}` : '';
      console.log(`${status} ${server.name} (${address}) - ${responseTime}ms${errorInfo}`);

    } catch (error) {
      const responseTime = Date.now() - startTime;
      const sourceIP = await this.getSourceIP();
      responseData = {
        server_id: server.id,
        response_time: responseTime,
        is_success: false,
        error_message: error instanceof Error ? error.message : 'Unknown error',
        source_ip: sourceIP,
        checked_at: getIranDate()
      };

      await this.storeResponse(responseData);
      const address = server.port ? `${server.ip_address}:${server.port}` : server.ip_address;
      console.log(`❌ ${server.name} (${address}) - Error: ${responseData.error_message}`);
    } finally {
      // در هر حالتی (موفق یا ناموفق) flag را پاک کن
      this.checkingServers.delete(server.id);
    }
  }

  private async checkHttpServer(server: Server, startTime: number, sourceIP: string): Promise<ResponseData> {
    return new Promise((resolve) => {
      let url: string;
      if (server.endpoint) {
        url = server.endpoint;
      } else {
        // Build URL with port if available, otherwise use default ports
        const port = server.port || (server.request_type === 'https' ? 443 : 80);
        url = `${server.request_type}://${server.ip_address}:${port}`;
      }
      const isHttps = server.request_type === 'https';
      const client = isHttps ? https : http;

      const request = client.request(url, {
        method: 'GET',
        timeout: server.timeout,
        headers: {
          'User-Agent': 'ServerMonitor/1.0',
          'Accept': '*/*',
          'Connection': 'close'
        }
      }, (response) => {
        let responseBody = '';
        let responseSize = 0;

        response.on('data', (chunk) => {
          responseBody += chunk;
          responseSize += chunk.length;
        });

        response.on('end', () => {
          const responseTime = Date.now() - startTime;
          const isSuccess = response.statusCode === server.expected_status_code;

          resolve({
            server_id: server.id,
            response_time: responseTime,
            status_code: response.statusCode,
            response_size: responseSize,
            is_success: isSuccess,
            response_headers: response.headers as Record<string, string>,
            response_body: responseBody.substring(0, 1000), // Limit body size
            source_ip: sourceIP,
            checked_at: getIranDate()
          });
        });
      });

      request.on('error', (error) => {
        const responseTime = Date.now() - startTime;
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: error.message,
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      request.on('timeout', () => {
        const responseTime = Date.now() - startTime;
        request.destroy();
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: 'Request timeout',
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      request.setTimeout(server.timeout);
      request.end();
    });
  }

  private async checkTcpServer(server: Server, startTime: number, sourceIP: string): Promise<ResponseData> {
    return new Promise((resolve) => {
      // TCP checks require a port, so if no port is specified, return an error
      if (!server.port) {
        const responseTime = Date.now() - startTime;
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: 'Port is required for TCP checks',
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
        return;
      }

      const socket = new net.Socket();
      let isResolved = false;

      const cleanup = () => {
        if (!isResolved) {
          isResolved = true;
          socket.destroy();
        }
      };

      socket.setTimeout(server.timeout);
      socket.connect(server.port, server.ip_address, () => {
        const responseTime = Date.now() - startTime;
        cleanup();
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: true,
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      socket.on('error', (error) => {
        const responseTime = Date.now() - startTime;
        cleanup();
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: error.message,
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      socket.on('timeout', () => {
        const responseTime = Date.now() - startTime;
        cleanup();
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: 'Connection timeout',
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });
    });
  }

  private async checkPingServer(server: Server, startTime: number, sourceIP: string): Promise<ResponseData> {
    // Use ICMP ping for proper ping functionality
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);
    
    try {
      // Use ping command with timeout
      const timeout = Math.ceil(server.timeout / 1000); // Convert to seconds
      const command = `ping -c 1 -W ${timeout} ${server.ip_address}`;
      
      const { stdout, stderr } = await execAsync(command);
      
      // Parse ping output to get response time
      const timeMatch = stdout.match(/time=(\d+\.?\d*)/);
      const responseTime = timeMatch ? parseFloat(timeMatch[1]) : (Date.now() - startTime);
      
      return {
        server_id: server.id,
        response_time: responseTime,
        is_success: true,
        source_ip: sourceIP,
        checked_at: getIranDate()
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        server_id: server.id,
        response_time: responseTime,
        is_success: false,
        error_message: `Ping failed: ${error instanceof Error ? error.message : String(error)}`,
        source_ip: sourceIP,
        checked_at: getIranDate()
      };
    }
  }

  private async storeResponse(responseData: ResponseData): Promise<void> {
    try {
      // Determine status based on success and error conditions
      let status = 'up';
      if (!responseData.is_success) {
        if (responseData.error_message?.includes('timeout')) {
          status = 'timeout';
        } else if (responseData.error_message) {
          status = 'error';
        } else {
          status = 'down';
        }
      }

      await this.dbClient.query(`
        INSERT INTO monitoring_data (server_id, status, response_time, status_code, response_size, is_success, error_message, response_headers, response_body, source_ip, checked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        responseData.server_id,
        status,
        responseData.response_time,
        responseData.status_code,
        responseData.response_size,
        responseData.is_success,
        responseData.error_message,
        responseData.response_headers ? JSON.stringify(responseData.response_headers) : null,
        responseData.response_body,
        responseData.source_ip,
        responseData.checked_at
      ]);
    } catch (error) {
      console.error('❌ Failed to store response:', error);
    }
  }

  async getServerStats(): Promise<void> {
    try {
      const result = await this.dbClient.query(`
        SELECT 
          s.name,
          s.ip_address,
          s.port,
          s.request_type,
          s.server_group,
          s.color,
          COUNT(m.id) as total_checks,
          COUNT(CASE WHEN m.is_success = true THEN 1 END) as successful_checks,
          ROUND(AVG(m.response_time), 2) as avg_response_time,
          ROUND(MIN(m.response_time), 2) as min_response_time,
          ROUND(MAX(m.response_time), 2) as max_response_time,
          MAX(m.checked_at) as last_check,
          (SELECT source_ip FROM monitoring_data m2 WHERE m2.server_id = s.id ORDER BY m2.checked_at DESC LIMIT 1) as last_source_ip
        FROM servers s
        LEFT JOIN monitoring_data m ON s.id = m.server_id
        WHERE s.is_active = true
        GROUP BY s.id, s.name, s.ip_address, s.port, s.request_type, s.server_group, s.color
        ORDER BY s.name
      `);

      console.log('\n📊 Server Statistics:');
      console.log('='.repeat(120));
      console.log('Name'.padEnd(20) + 'Address'.padEnd(20) + 'Type'.padEnd(8) + 'Group'.padEnd(12) + 'Checks'.padEnd(8) + 'Success'.padEnd(8) + 'Avg Time'.padEnd(10) + 'Source IP'.padEnd(15) + 'Last Check');
      console.log('-'.repeat(120));

      for (const row of result.rows) {
        const successRate = row.total_checks > 0 ? ((row.successful_checks / row.total_checks) * 100).toFixed(1) : '0.0';
        const lastCheck = row.last_check ? formatIranDate(new Date(row.last_check)) : 'Never';
        
        const address = row.port ? `${row.ip_address}:${row.port}` : row.ip_address;
        const sourceIP = row.last_source_ip || 'Unknown';
        console.log(
          row.name.padEnd(20) +
          address.padEnd(20) +
          row.request_type.padEnd(8) +
          (row.server_group || 'N/A').padEnd(12) +
          row.total_checks.toString().padEnd(8) +
          `${successRate}%`.padEnd(8) +
          `${row.avg_response_time || 0}ms`.padEnd(10) +
          sourceIP.padEnd(15) +
          lastCheck
        );
      }
      console.log('='.repeat(120));
    } catch (error) {
      console.error('❌ Failed to get server stats:', error instanceof Error ? error.message : String(error));
    }
  }

  async stopMonitoring(): Promise<void> {
    this.isRunning = false;
    
    // Clear all intervals
    for (const interval of this.activeChecks.values()) {
      clearInterval(interval);
    }
    this.activeChecks.clear();
    
    // Clear checking flags
    this.checkingServers.clear();

    console.log('🛑 Server monitoring stopped');
  }

  async cleanup(): Promise<void> {
    await this.stopMonitoring();
    await this.dbClient.end();
    console.log('🧹 Cleanup completed');
  }
}

// Main execution
async function main() {
  const monitor = new ServerMonitor();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await monitor.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await monitor.cleanup();
    process.exit(0);
  });

  try {
    await monitor.initialize();
    await monitor.startMonitoring();

    // Show stats every 5 minutes
    setInterval(async () => {
      await monitor.getServerStats();
    }, 300000);

    // Show initial stats
    setTimeout(async () => {
      await monitor.getServerStats();
    }, 10000);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await monitor.cleanup();
    process.exit(1);
  }
}

// Run the application
if (require.main === module) {
  main().catch(console.error);
}

export { ServerMonitor, Server, ResponseData };

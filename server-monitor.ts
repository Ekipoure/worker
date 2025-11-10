#!/usr/bin/env ts-node

import { Client } from 'pg';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { promisify } from 'util';
import moment from 'moment-timezone';

// Database configuration
const DB_CONFIG = {
  connectionString: 'postgresql://admin:admin123@5.2.69.16:5432/radar'
};

// Timezone configuration
const IRAN_TIMEZONE = 'Asia/Tehran';

// Helper function to get Iran timezone aware date for PostgreSQL
// Returns a Date object that represents the current time in Iran timezone
// Note: This is kept for backward compatibility but should use getIranTimestampString() for database operations
function getIranDate(): Date {
  // Get current time in Iran timezone
  const iranMoment = moment().tz(IRAN_TIMEZONE);
  // Return as Date - but be aware this is converted to UTC internally
  return iranMoment.toDate();
}

// Helper function to format date string in Iran timezone for explicit SQL insertion
function getIranDateString(): string {
  return moment().tz(IRAN_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
}

// Helper function to get Iran timezone timestamp string with explicit timezone for PostgreSQL
// This is the recommended way to insert timestamps to ensure correct timezone handling
function getIranTimestampString(): string {
  // Format: 'YYYY-MM-DD HH:mm:ss' with timezone offset
  // PostgreSQL will correctly interpret this as Iran timezone
  return moment().tz(IRAN_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
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
  private refreshInterval?: NodeJS.Timeout; // برای refresh دوره‌ای سرورها
  private monitoredServerIds: Set<number> = new Set(); // لیست سرورهایی که در حال مانیتور هستند

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

  // Helper method to ensure timezone is set correctly (can be called periodically)
  private async ensureTimezone(): Promise<void> {
    try {
      // Set timezone to Iran at the session level
      await this.dbClient.query(`SET timezone = '${IRAN_TIMEZONE}'`);
      
      // Verify timezone is set correctly
      const tzResult = await this.dbClient.query(`SELECT current_setting('timezone') as timezone`);
      const timezoneValue = tzResult.rows[0]?.timezone || 'unknown';
      
      if (timezoneValue !== IRAN_TIMEZONE) {
        console.warn(`⚠️  Warning: Database timezone is ${timezoneValue}, expected ${IRAN_TIMEZONE}. Retrying...`);
        await this.dbClient.query(`SET timezone = '${IRAN_TIMEZONE}'`);
        // Verify again
        const tzResult2 = await this.dbClient.query(`SELECT current_setting('timezone') as timezone`);
        const timezoneValue2 = tzResult2.rows[0]?.timezone || 'unknown';
        if (timezoneValue2 !== IRAN_TIMEZONE) {
          console.error(`❌ Failed to set database timezone to ${IRAN_TIMEZONE}. Current: ${timezoneValue2}`);
        }
      }
    } catch (error) {
      console.error('❌ Error ensuring timezone:', error);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.dbClient.connect();
      
      // Set timezone to Iran immediately after connection
      // IMPORTANT: This sets timezone at the database SESSION level, not system level
      // This means it works regardless of:
      // - Where the server is located (US, Europe, Asia, etc.)
      // - What timezone the operating system is using
      // - What timezone the PostgreSQL server is configured with
      // Each connection gets its own session with Iran timezone
      await this.ensureTimezone();
      
      // Show current time in Iran timezone for verification
      const currentTimeResult = await this.dbClient.query(`SELECT NOW() AT TIME ZONE '${IRAN_TIMEZONE}' as current_time`);
      const dbTime = currentTimeResult.rows[0].current_time;
      const localIranTime = moment().tz(IRAN_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
      console.log(`📅 Database timezone: ${IRAN_TIMEZONE}`);
      console.log(`🕐 Database time (Iran): ${dbTime}`);
      console.log(`🕐 Local time (Iran): ${localIranTime}`);
      
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
          response_time NUMERIC(10, 3),
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

      // Migrate response_time column from INTEGER/DECIMAL to NUMERIC(10, 3) if needed
      // This is critical because worker sends decimal values like "118.467"
      try {
        const columnType = await this.dbClient.query(`
          SELECT data_type, numeric_precision, numeric_scale
          FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = 'monitoring_data' 
            AND column_name = 'response_time'
        `);
        
        if (columnType.rows.length > 0) {
          const currentType = columnType.rows[0].data_type;
          const currentPrecision = columnType.rows[0].numeric_precision;
          const currentScale = columnType.rows[0].numeric_scale;
          
          // Check if it's INTEGER or DECIMAL with wrong precision/scale
          if (currentType === 'integer' || 
              (currentType === 'numeric' && (currentPrecision !== 10 || currentScale !== 3)) ||
              (currentType === 'numeric' && currentPrecision === null)) {
            console.log(`Migrating response_time column from ${currentType} to NUMERIC(10, 3)...`);
            
            await this.dbClient.query(`
              ALTER TABLE monitoring_data 
              ALTER COLUMN response_time TYPE NUMERIC(10, 3)
              USING CASE 
                WHEN response_time IS NULL THEN NULL
                ELSE response_time::NUMERIC(10, 3)
              END
            `);
            
            console.log('✅ Successfully migrated response_time column to NUMERIC(10, 3)');
          }
        }
      } catch (error) {
        console.log('Warning: Could not migrate response_time column type:', error instanceof Error ? error.message : 'Unknown error');
        // Don't throw - this is a migration that might fail if column doesn't exist yet
      }

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

    // Start periodic refresh to detect new servers (every 30 seconds)
    this.refreshInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.refreshServers();
      }
    }, 30000); // هر 30 ثانیه یک بار بررسی می‌کند

    console.log('✅ Server monitoring started. Press Ctrl+C to stop.');
    console.log('🔄 Auto-refresh enabled: New servers will be detected every 30 seconds.');
  }

  private async loadAndStartMonitoring(): Promise<void> {
    try {
      const result = await this.dbClient.query(`
        SELECT * FROM servers WHERE is_active = true ORDER BY id
      `);

      const servers: Server[] = result.rows;

      for (const server of servers) {
        await this.startMonitoringServer(server);
      }

      console.log(`📊 Monitoring ${servers.length} active servers`);
    } catch (error) {
      console.error('❌ Error loading servers:', error);
    }
  }

  private async startMonitoringServer(server: Server): Promise<void> {
    // اگر این سرور قبلاً در حال مانیتور است، skip کن
    if (this.monitoredServerIds.has(server.id)) {
      return;
    }

    // Clear existing interval for this server (اگر وجود داشت)
    const existingInterval = this.activeChecks.get(server.id);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    // Start new monitoring for this server
    const interval = setInterval(async () => {
      // برای هر interval، سرور را دوباره از دیتابیس بخوان تا تغییرات اعمال شود
      try {
        const result = await this.dbClient.query(`
          SELECT * FROM servers WHERE id = $1 AND is_active = true
        `, [server.id]);
        
        if (result.rows.length === 0) {
          // سرور دیگر active نیست، stop کن
          this.stopMonitoringServer(server.id);
          return;
        }
        
        const updatedServer: Server = result.rows[0];
        await this.checkServer(updatedServer);
      } catch (error) {
        console.error(`❌ Error checking server ${server.name}:`, error);
      }
    }, server.check_interval * 1000);

    this.activeChecks.set(server.id, interval);
    this.monitoredServerIds.add(server.id);

    // Run initial check immediately (async without await to avoid blocking)
    this.checkServer(server).catch(err => {
      console.error(`❌ Error in initial check for ${server.name}:`, err);
    });
  }

  private stopMonitoringServer(serverId: number): void {
    const interval = this.activeChecks.get(serverId);
    if (interval) {
      clearInterval(interval);
      this.activeChecks.delete(serverId);
      this.monitoredServerIds.delete(serverId);
    }
  }

  private async refreshServers(): Promise<void> {
    try {
      const result = await this.dbClient.query(`
        SELECT * FROM servers WHERE is_active = true ORDER BY id
      `);

      const currentServerIds = new Set<number>();
      const servers: Server[] = result.rows;

      // سرورهای جدید را اضافه کن
      for (const server of servers) {
        currentServerIds.add(server.id);
        
        if (!this.monitoredServerIds.has(server.id)) {
          // سرور جدید پیدا شد
          console.log(`🆕 New server detected: ${server.name} (ID: ${server.id}). Starting monitoring...`);
          await this.startMonitoringServer(server);
        }
      }

      // سرورهایی که دیگر active نیستند را stop کن
      for (const monitoredId of this.monitoredServerIds) {
        if (!currentServerIds.has(monitoredId)) {
          console.log(`⏹️  Server (ID: ${monitoredId}) is no longer active. Stopping monitoring...`);
          this.stopMonitoringServer(monitoredId);
        }
      }

    } catch (error) {
      console.error('❌ Error refreshing servers:', error);
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
          // اگر response time بیشتر از timeout باشد، timeout تشخیص داده می‌شود
          const isSuccess = responseTime <= server.timeout;

          resolve({
            server_id: server.id,
            response_time: responseTime,
            status_code: response.statusCode,
            response_size: responseSize,
            is_success: isSuccess,
            response_headers: response.headers as Record<string, string>,
            response_body: responseBody.substring(0, 1000), // Limit body size
            error_message: !isSuccess ? `Response time ${responseTime}ms exceeds timeout ${server.timeout}ms` : undefined,
            source_ip: sourceIP,
            checked_at: getIranDate()
          });
        });
      });

      request.on('error', (error) => {
        const responseTime = Date.now() - startTime;
        // اگر response time برگردانده شده، سرور آنلاین است (حتی با خطا)
        // فقط اگر timeout کامل شود (response_time >= timeout)، آفلاین است
        const isSuccess = responseTime < server.timeout;
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: isSuccess,
          error_message: isSuccess ? error.message : 'No response received',
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      request.on('timeout', () => {
        const responseTime = Date.now() - startTime;
        request.destroy();
        // timeout کامل = هیچ response time برنگردانده شده = آفلاین
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: 'Request timeout - No response received',
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
        // اگر response time بیشتر از timeout باشد، timeout تشخیص داده می‌شود
        const isSuccess = responseTime <= server.timeout;
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: isSuccess,
          error_message: !isSuccess ? `Connection time ${responseTime}ms exceeds timeout ${server.timeout}ms` : undefined,
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      socket.on('error', (error) => {
        const responseTime = Date.now() - startTime;
        cleanup();
        // اگر خطا سریع برگردد (response_time < timeout)، سرور آنلاین است
        // فقط اگر timeout کامل شود (response_time >= timeout)، آفلاین است
        const isSuccess = responseTime < server.timeout;
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: isSuccess,
          error_message: isSuccess ? error.message : 'Connection timeout - No response received',
          source_ip: sourceIP,
          checked_at: getIranDate()
        });
      });

      socket.on('timeout', () => {
        const responseTime = Date.now() - startTime;
        cleanup();
        // timeout کامل = هیچ response time برنگردانده شده = آفلاین
        resolve({
          server_id: server.id,
          response_time: responseTime,
          is_success: false,
          error_message: 'Connection timeout - No response received',
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
      
      // Parse the actual ping time from the output
      // Try multiple methods to extract the most accurate ping time
      const fallbackTime = Date.now() - startTime; // Fallback to total execution time
      let responseTime = fallbackTime;
      const lines = stdout.split('\n');
      
      // Method 1: Try to extract from rtt statistics line (most accurate)
      // Format: "rtt min/avg/max/mdev = 60.547/60.547/60.547/0.000 ms"
      const rttLine = lines.find((line: string) => line.includes('rtt') && line.includes('min/avg/max'));
      if (rttLine) {
        const rttMatch = rttLine.match(/min\/avg\/max\/mdev\s*=\s*[\d.]+\/([\d.]+)\/[\d.]+\//i);
        if (rttMatch && rttMatch[1]) {
          const extractedTime = parseFloat(rttMatch[1]);
          if (!isNaN(extractedTime) && extractedTime > 0 && extractedTime < 100000) {
            responseTime = extractedTime;
          }
        }
      }
      
      // Method 2: Extract from the response line (contains "bytes from")
      // Format: "64 bytes from 99.84.152.26: icmp_seq=1 ttl=52 time=82.5 ms"
      if (responseTime === fallbackTime) {
        const responseLine = lines.find((line: string) => line.includes('bytes from') && line.includes('time'));
        if (responseLine) {
          // Try different patterns: time=82.5 ms, time=82 ms, time:82.5ms
          const timeMatch = responseLine.match(/time[=:](\d+\.?\d*)\s*ms/i) ||
                           responseLine.match(/time[=:](\d+\.?\d*)ms/i);
          if (timeMatch && timeMatch[1]) {
            const extractedTime = parseFloat(timeMatch[1]);
            if (!isNaN(extractedTime) && extractedTime > 0 && extractedTime < 100000) {
              responseTime = extractedTime;
            }
          }
        }
      }
      
      // Method 3: Fallback - try to match time= pattern anywhere (but prefer earlier matches)
      if (responseTime === fallbackTime) {
        const timeMatch = stdout.match(/time[=:](\d+\.?\d*)\s*ms/i) ||
                         stdout.match(/time[=:](\d+\.?\d*)ms/i);
        if (timeMatch && timeMatch[1]) {
          const extractedTime = parseFloat(timeMatch[1]);
          if (!isNaN(extractedTime) && extractedTime > 0 && extractedTime < 100000) {
            responseTime = extractedTime;
          }
        }
      }
      
      // Log warning if we couldn't extract ping time (for debugging)
      if (responseTime === fallbackTime && fallbackTime > 1000) {
        console.warn(`⚠️  Could not parse ping time from output for ${server.ip_address}. Using total execution time: ${fallbackTime}ms`);
      }
      
      // اگر response time بیشتر از timeout باشد، timeout تشخیص داده می‌شود
      const isSuccess = responseTime <= server.timeout;
      
      return {
        server_id: server.id,
        response_time: responseTime,
        is_success: isSuccess,
        error_message: !isSuccess ? `Ping time ${responseTime}ms exceeds timeout ${server.timeout}ms` : undefined,
        source_ip: sourceIP,
        checked_at: getIranDate()
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      // اگر ping timeout کامل شود (response_time >= timeout)، آفلاین است
      // در غیر این صورت، اگر خطا سریع برگردد، هنوز آنلاین است
      const isSuccess = responseTime < server.timeout;
      return {
        server_id: server.id,
        response_time: responseTime,
        is_success: isSuccess,
        error_message: isSuccess 
          ? `Ping error: ${error instanceof Error ? error.message : String(error)}`
          : 'Ping timeout - No response received',
        source_ip: sourceIP,
        checked_at: getIranDate()
      };
    }
  }

  private async storeResponse(responseData: ResponseData): Promise<void> {
    try {
      // Determine status based on success and error conditions
      // سرور فقط زمانی آفلاین است که هیچ response time برنگردانده باشد
      // یا response time بیشتر از timeout باشد
      let status = 'up';
      if (!responseData.is_success) {
        // چک کنم که آیا response time بیشتر از timeout است
        if (responseData.error_message?.includes('exceeds timeout')) {
          status = 'timeout'; // Timeout - response time از حد مجاز بیشتر است
        } else if (responseData.error_message?.includes('No response received')) {
          status = 'down'; // آفلاین - هیچ پاسخی دریافت نشده
        } else if (responseData.error_message?.includes('timeout')) {
          status = 'timeout'; // Timeout - timeout کامل
        } else {
          status = 'down'; // آفلاین - هیچ پاسخی دریافت نشده
        }
      }

      // Insert monitoring data with checked_at in Iran timezone
      // Use explicit timezone conversion to ensure correct storage regardless of server timezone
      // JavaScript Date objects are stored as UTC internally
      // We need to interpret the Date as UTC first, then convert to Iran timezone
      // This ensures correct conversion regardless of the server's system timezone
      const checkedAtMoment = moment.utc(responseData.checked_at).tz(IRAN_TIMEZONE);
      const iranTimeString = checkedAtMoment.format('YYYY-MM-DD HH:mm:ss');
      
      // Use PostgreSQL's explicit timezone conversion to ensure correct storage
      // This interprets the timestamp string as being in Iran timezone, then converts to timestamptz
      // This approach works regardless of the server's system timezone or PostgreSQL server timezone
      await this.dbClient.query(`
        INSERT INTO monitoring_data (server_id, status, response_time, status_code, response_size, is_success, error_message, response_headers, response_body, source_ip, checked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ($11::timestamp AT TIME ZONE '${IRAN_TIMEZONE}')::timestamp with time zone)
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
        iranTimeString
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
    
    // Clear refresh interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    
    // Clear all intervals
    for (const interval of this.activeChecks.values()) {
      clearInterval(interval);
    }
    this.activeChecks.clear();
    
    // Clear checking flags
    this.checkingServers.clear();
    
    // Clear monitored servers list
    this.monitoredServerIds.clear();

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

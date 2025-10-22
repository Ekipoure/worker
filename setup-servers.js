#!/usr/bin/env node

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Database configuration
const DB_CONFIG = {
  connectionString: 'postgresql://neondb_owner:npg_6VrBJeTUgRj4@ep-solitary-meadow-ad8vsnhd-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
};

async function setupServers() {
  const client = new Client(DB_CONFIG);
  
  try {
    console.log('🔌 Connecting to database...');
    await client.connect();
    
    console.log('📖 Reading SQL file...');
    const sqlFile = path.join(__dirname, 'setup-sample-servers.sql');
    const sqlContent = fs.readFileSync(sqlFile, 'utf8');
    
    console.log('🚀 Executing SQL script...');
    await client.query(sqlContent);
    
    console.log('✅ Sample servers setup completed successfully!');
    console.log('📊 You can now run the monitoring script with: npm start');
    
  } catch (error) {
    console.error('❌ Error setting up servers:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run setup if this file is executed directly
if (require.main === module) {
  setupServers().catch(console.error);
}

module.exports = { setupServers };

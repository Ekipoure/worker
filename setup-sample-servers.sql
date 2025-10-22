-- Sample servers for testing the monitoring system
-- Run this script to populate the database with test servers

-- Insert sample servers
INSERT INTO servers (name, ip_address, port, request_type, expected_status_code, server_group, color, check_interval, timeout, is_active) VALUES
('Google DNS', '8.8.8.8', 53, 'tcp', NULL, 'global', '#00ff00', 30, 5000, true),
('Google HTTP', 'google.com', 80, 'http', 200, 'global', '#0066ff', 60, 10000, true),
('Google HTTPS', 'google.com', 443, 'https', 200, 'global', '#00ccff', 60, 10000, true),
('Cloudflare DNS', '1.1.1.1', 53, 'tcp', NULL, 'global', '#ff6600', 30, 5000, true),
('Cloudflare HTTP', 'cloudflare.com', 80, 'http', 200, 'global', '#ff3366', 60, 10000, true),
('Cloudflare HTTPS', 'cloudflare.com', 443, 'https', 200, 'global', '#ff0033', 60, 10000, true),
('OpenDNS', '208.67.222.222', 53, 'tcp', NULL, 'global', '#9900ff', 30, 5000, true),
('GitHub', 'github.com', 443, 'https', 200, 'global', '#333333', 120, 15000, true),
('Stack Overflow', 'stackoverflow.com', 443, 'https', 200, 'global', '#f48024', 120, 15000, true),
('Wikipedia', 'wikipedia.org', 443, 'https', 200, 'global', '#000000', 120, 15000, true),
('Iranian Server 1', '185.199.108.153', 80, 'http', 200, 'iranian', '#ff0000', 30, 5000, true),
('Iranian Server 2', '185.199.109.153', 443, 'https', 200, 'iranian', '#cc0000', 30, 5000, true),
('Local Test Server', '127.0.0.1', 3000, 'http', 200, 'local', '#00ff00', 10, 2000, false);

-- Insert some sample monitoring data for demonstration
INSERT INTO monitoring_data (server_id, response_time, is_success, status_code, checked_at) VALUES
(1, 15.5, true, NULL, NOW() - INTERVAL '1 minute'),
(1, 12.3, true, NULL, NOW() - INTERVAL '2 minutes'),
(1, 18.7, true, NULL, NOW() - INTERVAL '3 minutes'),
(2, 245.2, true, 200, NOW() - INTERVAL '1 minute'),
(2, 198.5, true, 200, NOW() - INTERVAL '2 minutes'),
(2, 312.8, true, 200, NOW() - INTERVAL '3 minutes'),
(3, 156.7, true, 200, NOW() - INTERVAL '1 minute'),
(3, 134.2, true, 200, NOW() - INTERVAL '2 minutes'),
(3, 189.3, true, 200, NOW() - INTERVAL '3 minutes');

-- Show inserted data
SELECT 'Servers inserted:' as info, COUNT(*) as count FROM servers;
SELECT 'Monitoring data inserted:' as info, COUNT(*) as count FROM monitoring_data;

-- Show sample servers
SELECT 
    id, 
    name, 
    ip_address, 
    port, 
    request_type, 
    server_group, 
    is_active,
    check_interval,
    timeout
FROM servers 
ORDER BY server_group, name;

local key = KEYS[1]
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local val = ARGV[3]
redis.call('RPUSH', key, val)
redis.call('LTRIM', key, -max, -1)
redis.call('EXPIRE', key, ttl)
return redis.call('LLEN', key)

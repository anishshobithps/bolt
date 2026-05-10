local key = KEYS[1]
local ttl = tonumber(ARGV[1])
if redis.call('EXISTS', key) == 1 then
    redis.call('EXPIRE', key, ttl)
end
return redis.call('TTL', key)

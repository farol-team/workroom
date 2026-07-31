# Which store holds what the rooms know.
#
# PostgreSQL until a context database is configured, and the swap is one
# environment variable because nothing outside `Memory::Store` knows the
# difference (Article S1).
Rails.application.config.to_prepare do
  Memory::Store.current =
    if ENV["OPENVIKING_URL"].present?
      Memory::OpenViking.new(base_url: ENV["OPENVIKING_URL"], api_key: ENV["OPENVIKING_API_KEY"])
    else
      Memory::Local.new
    end
end

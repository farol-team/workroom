require "net/http"

module Memory
  # The context database, over its HTTP surface.
  #
  # OpenViking is not a passive store: it computes tiers and retrieves by
  # meaning. What it does not have is our vocabulary — trust, an author, a
  # channel — so those travel in front matter and in tags, and this adapter is
  # the only place that knows either representation (Article P1).
  class OpenViking < Store
    # A memory entry as the rest of the application expects one. The same
    # readers as an ActiveRecord row, so no call site can tell which store it is
    # talking to (Article S1).
    Entry = Struct.new(:uri, :title, :abstract, :overview, :detail, :trust,
                       :author_name, :created_at, :score, keyword_init: true) do
      def slice(*keys) = keys.index_with { |k| public_send(k) }
      def author = nil
    end

    # OpenViking's own directory summaries live alongside the entries. They are
    # its bookkeeping, not something the room said.
    INTERNAL = /\A\./

    def initialize(base_url: ENV["OPENVIKING_URL"], api_key: ENV["OPENVIKING_API_KEY"])
      @base = URI.parse(base_url.to_s.chomp("/"))
      @api_key = api_key
      @reachable = true
    end

    # The last thing the transport learned. Not a health check: a store is
    # unavailable because a request to it did not arrive, which is the only
    # moment anyone needs the answer.
    def available? = @reachable

    # --- reading -------------------------------------------------------------

    def all(channel, limit: 200)
      uris = list(root_of(channel)).first(limit)
      uris.filter_map { |uri| read(uri) }.sort_by.with_index { |e, i| [ e.trust == "human" ? 0 : 1, i ] }
    end

    def fetch(uri)
      read(uri)
    end

    # One `ls`, not a read per entry. `list` already drops directories and the
    # store's own bookkeeping, so this counts what `all` would list rather than
    # what the directory happens to contain — skills live in a subdirectory and
    # `ls` does not recurse.
    def count(channel)
      list(root_of(channel)).size
    end

    # `ls` does not recurse, so a channel's skills sit in plain sight of the
    # store and out of the way of what the room learned.
    def skills(channel, limit: 50)
      list(channel.skills_uri).first(limit).filter_map { |uri| read(uri) }
    end

    def write_skill(channel, title:, body:, key: nil, author: nil)
      key ||= title.to_s.parameterize.presence || SecureRandom.hex(4)
      uri = "#{channel.skills_uri}#{key}.md"
      uri = "#{channel.skills_uri}#{key}-#{SecureRandom.hex(3)}.md" if supersede(uri).present?

      entry = Entry.new(
        uri: uri, title: title, detail: body, trust: "human",
        overview: body.to_s.truncate(400), abstract: title,
        author_name: author.respond_to?(:name) ? author.name : author,
        created_at: Time.current
      )

      mkdir(channel.skills_uri)
      post("/api/v1/content/write", uri: uri, content: serialize(entry), mode: "create", wait: false)
      entry
    end

    def context_for(channel, limit: 20)
      entries = all(channel, limit: limit)
      # `all` swallows a transport failure and hands back nothing, which is the
      # same shape as a room that has learned nothing and the opposite fact.
      return Store::UNAVAILABLE unless available?
      return nil if entries.empty?

      lines = entries.map do |e|
        "#{e.trust == 'human' ? '•' : '◦'} #{e.title}\n  #{e.overview.presence || e.abstract}"
      end

      <<~TEXT
        What this room knows (#{channel.name}):

        #{lines.join("\n")}

        • stated by a person   ◦ inferred by an agent
        Ask for detail by URI when a task needs it.
      TEXT
    end

    # Retrieval by meaning rather than by substring — the reason for this store
    # existing. The channel is the search root, so scope stays structural.
    def search(channel, query, limit: 10)
      body = post("/api/v1/search/search",
                  query: query.to_s, target_uri: root_of(channel).chomp("/"),
                  limit: limit, include_provenance: true)
      hits = (body.dig("result", "resources") || [])
             .reject { |h| internal?(h["uri"]) }
             .first(limit)

      hits.filter_map do |hit|
        entry = read(hit["uri"])
        next unless entry
        # OpenViking's abstract is computed from the entry, not truncated from
        # it. Where it has one, it is better than ours.
        entry.abstract = hit["abstract"].presence || entry.abstract
        entry.score = hit["score"]
        entry
      end
    end

    # --- writing -------------------------------------------------------------

    def write(channel, title:, detail:, overview: nil, abstract: nil,
              trust: "agent", author: nil, source: nil, key: nil)
      key ||= title.to_s.parameterize.presence || SecureRandom.hex(4)
      uri = "#{root_of(channel)}#{key}.md"

      # A second entry under a taken name supersedes the first rather than
      # replacing it — the store has no overwrite, which suits Article P6.
      uri = "#{root_of(channel)}#{key}-#{SecureRandom.hex(3)}.md" if supersede(uri).present?

      entry = Entry.new(
        uri: uri, title: title, detail: detail, trust: trust,
        overview: overview.presence || detail.to_s.truncate(400),
        abstract: abstract.presence || title,
        author_name: author.respond_to?(:name) ? author.name : author,
        created_at: Time.current
      )

      mkdir(root_of(channel))
      # Not `wait: true`. The store computes an abstract and an embedding on
      # write, which takes seconds; an agent recording a conclusion mid-turn
      # must not sit through it. The entry is readable at once and retrievable
      # by meaning shortly after.
      post("/api/v1/content/write", uri: uri, content: serialize(entry), mode: "create", wait: false)
      tag(uri, entry, channel, source)
      entry
    end

    # Nothing is destroyed: the entry moves out of what the room currently knows
    # and into what it used to (Article P6).
    def supersede(uri, reason: nil)
      archive = archive_uri(uri)
      entry = read(uri)
      return nil unless entry

      mkdir(archive.rpartition("/").first + "/")
      post("/api/v1/fs/mv", from_uri: uri, to_uri: archive)
      entry
    end

    private

    def prefix = "viking://"

    # Where an entry goes when it stops being current: the same path, under the
    # other scope. Substituting into the uri would have returned it unchanged
    # the day the layout moved, and `fs/mv` from an entry to itself succeeds —
    # so a uri this layout cannot explain is an error rather than a guess.
    def archive_uri(uri)
      rest = uri.to_s.delete_prefix("#{prefix}resources/channels/")
      raise Error, "no archive path for #{uri}" if rest == uri.to_s || !rest.include?("/")

      "#{prefix}resources/superseded/#{rest}"
    end

    def root_of(channel)
      # The channel's uri is ours; the scope segment is OpenViking's. Only four
      # scopes exist — agent, resources, session, user — and shared knowledge
      # that belongs to no one person is `resources`.
      channel.memory_uri
    end

    def internal?(uri) = INTERNAL.match?(uri.to_s.split("/").last)

    def list(root)
      body = get("/api/v1/fs/ls", uri: root.chomp("/"))
      (body["result"] || [])
        .reject { |e| e["isDir"] }
        .map { |e| e["uri"] }
        .reject { |uri| internal?(uri) }
    rescue Error
      []
    end

    def read(uri)
      body = get("/api/v1/content/read", uri: uri)
      text = body["result"]
      return nil if text.blank?

      deserialize(uri, text)
    rescue Error
      nil
    end

    def mkdir(uri)
      post("/api/v1/fs/mkdir", uri: uri.chomp("/"))
    rescue Error
      nil # already there
    end

    # Tags are how a search can be narrowed later; the front matter is what
    # survives being read back. Both carry trust, deliberately (Article P4).
    def tag(uri, entry, channel, source)
      tags = [ "trust=#{entry.trust}", "channel=#{channel.slug}" ]
      tags << "author=#{entry.author_name.to_s.parameterize}" if entry.author_name.present?
      tags << "source=#{source.class.name.underscore}-#{source.id}" if source.respond_to?(:id)
      post("/api/v1/fs/attrs/set_tags", uri: uri, tags: tags)
    rescue Error
      nil # tagging is an index, not the record
    end

    # --- the record on disk --------------------------------------------------

    def serialize(entry)
      front = {
        "title" => entry.title, "trust" => entry.trust,
        "author" => entry.author_name, "overview" => entry.overview,
        "recorded" => entry.created_at.utc.iso8601
      }.compact

      "#{front.to_yaml}---\n\n# #{entry.title}\n\n#{entry.detail}\n"
    end

    def deserialize(uri, text)
      front, body = split_front_matter(text)
      title = front["title"].presence || body.lines.first.to_s.sub(/\A#\s*/, "").strip
      detail = body.sub(/\A#[^\n]*\n+/, "").strip

      Entry.new(
        uri: uri, title: title, detail: detail,
        trust: front["trust"].presence || "agent",
        overview: front["overview"].presence || detail.truncate(400),
        abstract: title,
        author_name: front["author"],
        created_at: (Time.zone.parse(front["recorded"].to_s) if front["recorded"])
      )
    end

    def split_front_matter(text)
      return [ {}, text ] unless text.start_with?("---")

      _, raw, body = text.split(/^---\s*$/, 3)
      [ YAML.safe_load(raw.to_s, permitted_classes: [ Time ]) || {}, body.to_s.strip ]
    rescue Psych::Exception
      [ {}, text ]
    end

    # --- transport -----------------------------------------------------------

    Error = Class.new(StandardError)

    def get(path, **params)
      uri = @base.dup
      uri.path = path
      uri.query = URI.encode_www_form(params)
      request(Net::HTTP::Get.new(uri))
    end

    def post(path, **payload)
      uri = @base.dup
      uri.path = path
      req = Net::HTTP::Post.new(uri)
      req["Content-Type"] = "application/json"
      req.body = payload.to_json
      request(req)
    end

    # Every way the store can fail to answer arrives as this adapter's own
    # error, so nothing above the seam has to know what HTTP is. A name that
    # does not resolve raises Socket::ResolutionError, which is a SocketError
    # and not a SystemCallError — it used to travel past every `rescue Error`
    # here and out of the controller (#146). A refused connection and both
    # timeouts already did not.
    def request(req)
      req["X-API-Key"] = @api_key
      res = begin
        Net::HTTP.start(@base.host, @base.port, use_ssl: @base.scheme == "https",
                        open_timeout: 5, read_timeout: 30) { |http| http.request(req) }
      rescue SocketError, SystemCallError, OpenSSL::SSL::SSLError,
             Net::OpenTimeout, Net::ReadTimeout => e
        @reachable = false
        raise Error, e.message
      end
      @reachable = true

      body = JSON.parse(res.body.presence || "{}")
      raise Error, body.dig("error", "message") || res.code if body["status"] == "error"

      body
    rescue JSON::ParserError => e
      raise Error, e.message
    end
  end
end

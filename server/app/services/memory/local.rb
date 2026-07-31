module Memory
  # PostgreSQL-backed context store. Mirrors the tiering of an external
  # context database: abstract for discovery, overview for orientation,
  # detail on demand.
  class Local < Store
    # What gets pushed into an agent session when someone enters a channel.
    # Overviews only — the detail tier is fetched through the rail if needed.
    def context_for(channel, limit: 20)
      entries = channel.memory_entries.current.by_trust.limit(limit)
      return nil if entries.empty?

      lines = entries.map do |e|
        mark = e.trust == "human" ? "•" : "◦"
        "#{mark} #{e.title}\n  #{e.overview.presence || e.abstract}"
      end

      <<~TEXT
        What this room knows (#{channel.name}):

        #{lines.join("\n")}

        • stated by a person   ◦ inferred by an agent
        Ask for detail by URI when a task needs it.
      TEXT
    end

    # Everything an entry says, as one string to match against.
    HAYSTACK = "concat_ws(' ', title, abstract, overview, detail)".freeze

    # Agents search with the question they were asked, not with a keyword. So the
    # query is read as terms: an entry matching any of them is a candidate, and
    # the one matching most of them comes first.
    def search(channel, query, limit: 10)
      terms = Store.terms_in(query)
      scope = channel.memory_entries.current
      return scope.by_trust.limit(limit) if terms.empty?

      likes = terms.map { |t| "%#{t}%" }
      matches = terms.map { "#{HAYSTACK} ILIKE ?" }.join(" OR ")
      rank = terms.map { "(CASE WHEN #{HAYSTACK} ILIKE ? THEN 1 ELSE 0 END)" }.join(" + ")

      scope.where(matches, *likes)
           .order(Arel.sql(MemoryEntry.sanitize_sql_array([ "#{rank} DESC", *likes ])))
           .by_trust.limit(limit)
    end

    def supersede(uri, reason: nil)
      entry = MemoryEntry.current.find_by(uri: uri)
      return nil unless entry

      entry.supersede!
      Activity.log(actor: entry.author || entry.channel, action: "memory.superseded",
                   subject: entry, reason: reason)
      entry
    end

    def write(channel, title:, detail:, overview: nil, abstract: nil,
              trust: "agent", author: nil, source: nil, key: nil)
      key ||= title.parameterize.presence || SecureRandom.hex(4)
      uri = "#{channel.memory_uri}#{key}"

      existing = MemoryEntry.current.find_by(uri: uri)
      existing&.supersede!

      MemoryEntry.create!(
        channel:, author:, source:, trust:,
        uri: existing ? "#{uri}-#{SecureRandom.hex(3)}" : uri,
        title:,
        detail:,
        overview: overview.presence || detail.to_s.truncate(400),
        abstract: abstract.presence || title
      )
    end
  end
end

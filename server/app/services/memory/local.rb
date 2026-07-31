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

    def search(channel, query, limit: 10)
      channel.memory_entries.current
             .where("title ILIKE :q OR abstract ILIKE :q OR overview ILIKE :q OR detail ILIKE :q",
                    q: "%#{query}%")
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

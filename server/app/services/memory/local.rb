module Memory
  # PostgreSQL-backed context store. Mirrors the tiering of an external
  # context database: abstract for discovery, overview for orientation,
  # detail on demand.
  class Local < Store
    # Everything an entry says, as one string to match against.
    HAYSTACK = "concat_ws(' ', title, abstract, overview, detail)".freeze

    # Agents search with the question they were asked, not with a keyword. So the
    # query is read as terms: an entry matching any of them is a candidate, and
    # the one matching most of them comes first.
    def fetch(uri)
      MemoryEntry.current.find_by(uri: uri)
    end

    def all(channel, limit: 200)
      knowledge(channel).by_trust.limit(limit)
    end

    # The same scope `all` lists, without the ordering or the limit. Counting
    # `memory_entries` directly is what #99 was: it includes skills, which the
    # listing beside it excludes.
    def count(channel) = knowledge(channel).count

    def skills(channel, limit: 50)
      channel.memory_entries.current
             .where("uri LIKE ?", "#{channel.skills_uri}%")
             .order(:created_at).limit(limit)
    end

    def write_skill(channel, title:, body:, key: nil, author: nil)
      MemoryEntry.create!(
        channel:, author:, trust: "human",
        **write_policy(channel.skills_uri, title: title, detail: body, key: key)
      )
    end

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

    # Everything under the channel's skills path is a procedure, not something
    # the room learned. The uri is the distinction, exactly as it is for access.
    def knowledge(channel)
      channel.memory_entries.current.where.not("uri LIKE ?", "#{channel.skills_uri}%")
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
      MemoryEntry.create!(
        channel:, author:, source:, trust:,
        **write_policy(channel.memory_uri, title:, detail:, overview:, abstract:, key:)
      )
    end

    # A row keeps its name after it stops being current, so what is filed under
    # a key is the plain uri or whatever a correction left it under. The tilde
    # is the store's own naming (see Store#write_policy) and nothing else can
    # sit there, which is what makes the prefix safe to search by.
    def displace(root, key, extension)
      entry = MemoryEntry.current
                         .where("uri = ? OR uri LIKE ?",
                                "#{root}#{key}#{extension}", "#{root}#{key}~%#{extension}")
                         .first
      entry&.supersede!
      entry
    end
  end
end

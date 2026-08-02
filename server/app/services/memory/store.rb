module Memory
  # The seam between WorkRoom and whatever holds the room's knowledge.
  # Callers never touch the backing store directly, so the local
  # implementation can be swapped for an external context database
  # without changing a single call site.
  class Store
    # Resolved per request, not per process. One process serves every workspace,
    # and a store chosen once at boot is a boundary that does not exist — the
    # half of a room's content retrieved by meaning would be shared by everybody
    # while the half in PostgreSQL is not (#140).
    def self.current
      @given || (Current.memory_store ||= Selection.new(ENV, Current.workspace).store)
    end

    # For a caller that has a store in hand and means it for every room: a
    # contract test against a real instance, or a script. Assigning outranks
    # resolving, and nothing in the application assigns — a room's store is a
    # property of the room, not of the process.
    def self.current=(store)
      @given = store
    end

    # Whether the store answered everything it was asked during this request.
    # Read right after a call, because that call is what learns it: a listing
    # that came back empty is a room that knows nothing only if this is true,
    # and a store that is down otherwise (#146). A store nobody has asked about
    # is taken at its word; one backed by nothing that can be away never stops
    # being available.
    def available? = true

    # What gets pushed into an agent session when somebody enters a channel.
    # Overviews only — the detail tier is fetched through the rail if needed.
    #
    # Written once rather than per store: this is how an agent reads what the
    # room knows, and it says nothing about where the entries were held. Both
    # stores carried the same twenty lines, letter for letter, and a change to
    # what every session opens with had two places to remember. A store with a
    # better rendering of its own is free to override it; neither has one.
    def context_for(channel, limit: 20)
      entries = all(channel, limit: limit)
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

    def search(_channel, _query, limit: 10) = raise NotImplementedError

    # Everything the room currently knows, most trusted first. Not search with
    # an empty query: a store with real retrieval has no reason to read "" as
    # "everything", and listing must not rest on one backend's accident.
    def all(_channel, limit: 200)         = raise NotImplementedError

    # How many things the room currently knows, counting the same set `all`
    # lists. Deliberately not `all(...).size`: that reads every entry to arrive
    # at a number, and the caller wanting the number usually wants nothing else.
    # A store answers this however it can do so cheaply.
    def count(_channel)                   = raise NotImplementedError

    # How work is done here, as opposed to what the room learned. A fact goes
    # stale; a procedure does not, and keeping them in one place is how a
    # hand-written rules file rots in the half that changes.
    #
    # Skills are not pushed into a session. They are found when they are wanted,
    # through the same rail as everything else.
    def skills(_channel, limit: 50)       = raise NotImplementedError
    def write_skill(_channel, title:, body:, key: nil, author: nil) = raise NotImplementedError

    # One entry, by the uri that identifies it. Search hands back uris and the
    # rail executes against them, so a store that cannot be asked for one is a
    # store the rail can find things in and never read.
    def fetch(_uri)                       = raise NotImplementedError
    def write(_channel, **_attrs)         = raise NotImplementedError

    # An agent that finds a contradiction resolves it rather than adding a
    # second conflicting entry. That obligation replaces the human gate, so it
    # has to be one call or it will not happen.
    def supersede(_uri, reason: nil)      = raise NotImplementedError

    # The journal lineage of a write the server witnessed, kept by the store
    # beside the entry so a reader of the entry can find the record of it
    # (#213). The journal is the source of truth and this is only its index,
    # so a store with no lineage index answers by doing nothing — `Memory::Local`
    # and any future store inherit this answer unchanged.
    def annotate(_uri, **_lineage)        = nil

    # An agent searches with the question it was asked, not with a keyword.
    # Reading a query into terms belongs to the seam rather than to any one
    # backend: the rail discovers its actions the same way memory is searched,
    # and a store that has its own retrieval simply ignores this.
    #
    # Function words are dropped. Terms in a language this list does not cover
    # are kept, which costs a little precision and loses nothing.
    STOPWORDS = %w[
      the and for with about this that what when where which who whom how why
      did does was were are our ours their your yours from into than then have
      has had any all can could should would will just not but you use using
      make made get let its over under between per via yet still also here
      there some such they them his her him she
    ].to_set.freeze

    def self.terms_in(query)
      query.to_s.downcase.scan(/[[:alnum:]]+/)
           .reject { |w| w.length < 3 || STOPWORDS.include?(w) }
           .uniq.first(8)
    end
  end
end

module Memory
  # The seam between WorkRoom and whatever holds the room's knowledge.
  # Callers never touch the backing store directly, so the local
  # implementation can be swapped for an external context database
  # without changing a single call site.
  class Store
    def self.current = @current ||= Local.new

    def self.current=(store)
      @current = store
    end

    def context_for(_channel, limit: 20)  = raise NotImplementedError
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

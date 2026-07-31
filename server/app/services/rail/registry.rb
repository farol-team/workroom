module Rail
  # What an agent may find and do inside one channel.
  #
  # Knowledge and actions are both capabilities, discovered the same way and
  # invoked the same way. That is the point of the rail: the tool surface stays
  # at two however many capabilities exist, so a session is not charged for
  # schemas it will never use.
  class Registry
    ACTIONS = {
      "workroom://memory/remember" => {
        title: "Remember something",
        summary: "Record a conclusion in this channel's memory so later work starts from it.",
        args: %w[title detail]
      },
      "workroom://memory/supersede" => {
        title: "Supersede a stale memory",
        summary: "Replace an entry this work contradicts. Resolve the conflict rather than adding to it.",
        args: %w[uri reason]
      }
    }.freeze

    def initialize(channel:, user:)
      @channel = channel
      @user = user
    end

    # Discovery reads abstracts. The whole entry is loaded only for what was
    # chosen — the rail compresses the tool surface, tiers compress the content.
    def search(query, limit: 10)
      knowledge = store.search(@channel, query.to_s, limit: limit).map do |e|
        { uri: e.uri, title: e.title, summary: e.abstract.presence || e.overview,
          kind: "knowledge", trust: e.trust }
      end
      knowledge + matching_actions(query)
    end

    def execute(uri, args = {})
      return run_action(uri, args) if ACTIONS.key?(uri)

      entry = @channel.memory_entries.current.find_by(uri: uri)
      return [ :error, "no capability at #{uri}" ] unless entry

      [ :ok, entry.detail.presence || entry.overview.to_s ]
    end

    def descriptors = [ SEARCH_TOOL, EXECUTE_TOOL ]

    SEARCH_TOOL = {
      name: "search_capabilities",
      description: "Find what this channel knows and what you may do here. " \
                   "Returns summaries; fetch the full text with execute_capability.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "What you are looking for" } },
        required: [ "query" ]
      }
    }.freeze

    EXECUTE_TOOL = {
      name: "execute_capability",
      description: "Read a capability's full text, or perform an action, by uri.",
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "The uri returned by search_capabilities" },
          args: { type: "object", description: "Arguments, for action capabilities" }
        },
        required: [ "uri" ]
      }
    }.freeze

    private

    def store = Memory::Store.current

    def matching_actions(query)
      q = query.to_s.downcase
      ACTIONS.filter_map do |uri, a|
        next if q.present? && !"#{uri} #{a[:title]} #{a[:summary]}".downcase.include?(q)
        { uri: uri, title: a[:title], summary: a[:summary], kind: "action", args: a[:args] }
      end
    end

    def run_action(uri, args)
      args = (args || {}).with_indifferent_access
      case uri
      when "workroom://memory/remember"
        return [ :error, "title and detail are required" ] if args[:title].blank? || args[:detail].blank?

        entry = store.write(@channel, title: args[:title], detail: args[:detail], trust: "agent")
        [ :ok, "Remembered as #{entry.uri}" ]
      when "workroom://memory/supersede"
        entry = store.supersede(args[:uri], reason: args[:reason])
        entry ? [ :ok, "Superseded #{entry.uri}" ] : [ :error, "nothing current at #{args[:uri]}" ]
      end
    end
  end
end

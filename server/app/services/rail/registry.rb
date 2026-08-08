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

    # The actions this channel offers: the fixed two, plus `publish` when the
    # room names a repository (#203). The url is the condition because the
    # instruction is to commit into the channel's clone — a room without one
    # has nothing to publish into, and offering the steps there would be a
    # capability that cannot be performed (#208).
    def actions
      ACTIONS.merge(
        if @channel.repository_url.present?
          { "workroom://channel/publish" => {
              title: "Publish a conclusion to the team's repository",
              summary: "Turn a conclusion in this channel's memory into a document the team keeps, reviewed like any other change.",
              args: [] } }
        else
          {}
        end
      )
    end

    # Discovery reads abstracts. The whole entry is loaded only for what was
    # chosen — the rail compresses the tool surface, tiers compress the content.
    def search(query, limit: 10)
      found = store.search(@channel, query.to_s, limit: limit).map do |e|
        # A procedure and a fact answer different questions, and an agent that
        # cannot tell them apart will cite one as the other.
        { uri: e.uri, title: e.title, summary: e.abstract.presence || e.overview,
          kind: skill?(e.uri) ? "skill" : "knowledge", trust: e.trust }
      end
      found + matching_actions(query) + matching_bound(query)
    end

    def execute(uri, args = {})
      return run_action(uri, args) if actions.key?(uri)
      return run_bound(uri, args) if uri.to_s.start_with?(BoundCapability::PREFIX)

      # Through the store, not the table: search returns uris from whichever
      # store is configured, and the rail must be able to read what it found.
      entry = uri.to_s.start_with?(@channel.memory_uri) ? store.fetch(uri) : nil
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

    # Instruction, not bound (#208). A commit happens in the clone on the
    # person's laptop, under their own git identity and their own credentials
    # — the server holds the url and never holds the repository, so there is
    # nothing here to execute. What the rail can honestly do is say exactly
    # how, which is what RAIL.md calls an instruction capability: text the
    # agent follows locally, a change to which takes effect on the next call.
    def publish_text
      <<~TEXT
        A conclusion in this channel's memory is a draft: cheap to write, cheap
        to supersede, read by whoever's agent asks next week. A document the
        team keeps is different — it is published deliberately, and reviewed.

        To publish, in the channel's working folder (the clone of
        #{@channel.repository_url}):

        1. Write the conclusion as a markdown file, in your own words.
        2. Commit it on your agent/<topic> branch — never on the repository's
           default branch (the session's standing rules).
        3. Push the branch with the person's own credentials, as them.
        4. Open a pull request. A human reviews and merges — you never merge
           yourself, asked or not.

        If any step needs a permission you do not have, stop and say what you
        would have done. The call is the person's, not yours.
      TEXT
    end

    # Capabilities answered by a system that is not ours, read by the same terms as
    # everything else: an agent describing what it wants to do should not have to
    # know whether the answer is a fact this room learned, a way this team works, or
    # a door out.
    #
    # Only what the operator judged read-only is listed. Offering something that
    # would then be refused is worse than not offering it — the agent plans around a
    # capability it cannot have.
    def matching_bound(query)
      terms = Memory::Store.terms_in(query)
      BoundCapability.offered.filter_map do |capability|
        text = "#{capability.uri} #{capability.title} #{capability.summary}".downcase
        next if terms.any? && terms.none? { |t| text.include?(t) }

        Bound.new(capability:).descriptor
      end
    end

    # A uri an agent saw yesterday is a uri an agent can send today, so read-only is
    # checked here and not only where the listing is built.
    def run_bound(uri, args)
      capability = BoundCapability.find_by_uri(uri)
      return [ :error, "no capability at #{uri}" ] unless capability
      unless capability.read_only
        return [ :error, "#{capability.key}: this changes something outside this room, " \
                         "which needs a person's decision — and that step is not built yet" ]
      end

      Bound.new(capability:).call(args)
    end

    # Read the same way knowledge is read: by terms, so an agent describing what
    # it wants to do finds the action that does it.
    def matching_actions(query)
      terms = Memory::Store.terms_in(query)
      actions.filter_map do |uri, a|
        text = "#{uri} #{a[:title]} #{a[:summary]}".downcase
        next if terms.any? && terms.none? { |t| text.include?(t) }
        { uri: uri, title: a[:title], summary: a[:summary], kind: "action", args: a[:args] }
      end
    end

    def skill?(uri) = uri.to_s.start_with?(@channel.skills_uri)

    # The turn this call belongs to. The rail is reached by an agent holding its
    # owner's token, not by the client, so the run is inferred from what that
    # person currently has open in this channel — which is exactly one thing.
    def working_run
      AgentRun.joins(:agent_session)
              .where(agent_sessions: { user_id: @user.id, channel_id: @channel.id })
              .where(status: "running")
              .order(started_at: :desc).first
    end

    def run_action(uri, args)
      args = (args || {}).with_indifferent_access
      case uri
      when "workroom://channel/publish"
        [ :ok, publish_text ]
      when "workroom://memory/remember"
        return [ :error, "title and detail are required" ] if args[:title].blank? || args[:detail].blank?

        # The token belongs to a person and the turn belongs to their agent, so
        # the entry can say both. Without them it says "agent" and stops there,
        # which is the entry Article P4 calls a defect.
        run = working_run
        entry = store.write(@channel, title: args[:title], detail: args[:detail],
                            trust: "agent", author: @user, source: run)
        run&.update(distilled_at: Time.current)
        # What was recorded, not only that something was: the entry's text is in
        # the journal because the git mirror replays envelopes and the store has
        # moved on by the time it does. A correction carries a reason instead —
        # it is the one thing a supersession knows.
        journaled = record("remember", uri: entry.uri, title: args[:title], detail: entry.detail, run: run)
        annotate(journaled, action: "remember", uri: entry.uri, title: args[:title],
                 detail: entry.detail, run: run)
        [ :ok, "Remembered as #{entry.uri}" ]
      when "workroom://memory/supersede"
        # The same question the read branch asks, for the same reason: this rail
        # is one channel's, and an entry it cannot read is not one it may
        # withdraw (Article P5).
        target = args[:uri].to_s
        return [ :error, "no capability at #{target}" ] unless target.start_with?(@channel.memory_uri)

        run = working_run
        entry = store.supersede(target, reason: args[:reason])
        return [ :error, "nothing current at #{target}" ] unless entry

        journaled = record("supersede", uri: entry.uri, reason: args[:reason], run: run)
        annotate(journaled, action: "supersede", uri: entry.uri, reason: args[:reason], run: run)
        [ :ok, "Superseded #{entry.uri}" ]
      end
    end

    # A write to memory is a thing that happened in the room, so the room's
    # journal says so — after the write succeeded, never before, and never for
    # one that was refused. The entry names the uri rather than a row id: the
    # rail writes to whichever store is configured, and only the uri means the
    # same thing in both. Who and which turn ride along, because an entry
    # nobody can trace back is a defect (Article P4). Returns the appended
    # record: its seq and hash are the lineage the store is told next.
    def record(action, uri:, run:, **rest)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { action:, uri:, trust: "agent", author_id: @user.id, run_id: run&.id }.merge(rest)
      )
    end

    # Lineage flows write → append → annotate, so the sidecar never claims a
    # record that does not exist (#213). The store keeps it beside the entry —
    # a reader of the entry finds the record of it, and the journal stays the
    # source of truth the sidecar only indexes.
    def annotate(journaled, action:, uri:, run:, **rest)
      store.annotate(uri, action:, uri:, trust: "agent", author_id: @user.id, run_id: run&.id,
                     seq: journaled.seq, entry_hash: journaled.entry_hash,
                     recorded_at: journaled.created_at, **rest)
    end
  end
end

module Memory
  # Who produced an entry and what it came from, in the words the room already
  # uses for an agent-authored message (`MessageSerializer`) — a person's name
  # and the agent that spoke for them, so "Leonid's agent" reads the same in
  # memory as it does in the transcript.
  #
  # Two stores express it differently and must not disagree. A row points at the
  # run and reads the rest through it; a context database can point at nothing
  # and has to carry the same facts inside the document it wrote. Both
  # representations are built here (Article P4).
  module Provenance
    module_function

    # What `of` is about to walk, loaded for a whole listing at once. A row
    # points at its run, the run at its session, the session at the person —
    # three queries per line of a memory panel, asked one line at a time (#177).
    #
    # A store that carries the facts inside the entry has nothing to load, and
    # says so by not being a row: this is where the two representations differ
    # and therefore where the difference is handled (Article P1).
    def preload(entries)
      rows = entries.select { |e| e.is_a?(MemoryEntry) }
      return entries if rows.empty?

      load_into(rows, [ :author, :source ])
      runs = rows.filter_map { |r| r.source if r.source.is_a?(AgentRun) }
      load_into(runs, :agent_session)
      # The person at the end of the chain, and only for an entry that does not
      # already name one: `of` reads the run's owner as a fallback, so asking
      # for them up front is a second pass over the same table for an answer
      # already in hand. Every write the product makes attributes its entry, so
      # this is usually no query at all.
      load_into(rows.select { |r| r.author.nil? }.filter_map(&:source).grep(AgentRun).map(&:agent_session), :user)
      entries
    end

    def load_into(records, associations)
      return if records.empty?

      ActiveRecord::Associations::Preloader.new(records: records, associations: associations).call
    end

    def of(entry)
      run = entry.source
      return { kind: entry.trust, name: entry.author_name || run.user.name, **of_run(run) } if run.is_a?(AgentRun)

      { kind: entry.trust, name: entry.author_name, agent_kind: entry.try(:agent_kind),
        model: entry.try(:model), run_id: entry.try(:run_id) }.compact
    end

    # The same facts as a document's front matter, for the store that cannot
    # point: what the run knows about itself is copied in at write time, because
    # afterwards there is nothing to ask.
    def front_matter(author:, source:, trust:)
      run = source if source.is_a?(AgentRun)
      { "trust" => trust, "author" => name_of(author) || run&.user&.name,
        "agent" => run && run.agent_session.agent_kind,
        "model" => run&.model, "run" => run&.id }.compact
    end

    def of_run(run)
      { agent_kind: run.agent_session.agent_kind, model: run.model, run_id: run.id }.compact
    end

    def name_of(author) = author.respond_to?(:name) ? author.name : author
  end
end

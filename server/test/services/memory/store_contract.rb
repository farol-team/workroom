# The contract every Memory::Store implementation must satisfy.
#
# Include it in a test class that defines `build_store`. Written before a second
# implementation exists so the interface is pinned by a passing suite rather than
# discovered while porting — the local store and the context database must be
# interchangeable at every call site (Article S1).
module Memory
  module StoreContract
    def setup
      @channel = channel(name: "Meetings")
      @other   = channel(name: "Marketing")
      @store   = build_store
    end

    # A store that retrieves by meaning indexes asynchronously; one that
    # retrieves by substring does not. The contract requires that a written
    # entry becomes findable — not that it is findable in the same millisecond.
    # A synchronous store satisfies this on the first attempt.
    def retrieving(seconds: 90)
      deadline = Time.current + seconds
      loop do
        result = yield
        return result if result.present? || Time.current > deadline
        sleep 2
      end
    end

    # --- context_for ---------------------------------------------------------

    def test_context_is_nil_when_the_room_knows_nothing
      assert_nil @store.context_for(@channel)
    end

    def test_context_distinguishes_what_a_person_stated_from_what_an_agent_inferred
      # The agent entry is written FIRST, so insertion order is the opposite of
      # the required order — only real trust ordering can satisfy this.
      @store.write(@channel, title: "Pricing pattern", detail: "Setup cost.", trust: "agent")
      @store.write(@channel, title: "Reporting cadence", detail: "Monthly.", trust: "human")

      context = @store.context_for(@channel)

      assert_includes context, "Reporting cadence"
      assert_includes context, "Pricing pattern"
      refute_equal context.index("Reporting cadence"), context.index("Pricing pattern")
      assert context.index("Reporting cadence") < context.index("Pricing pattern"),
             "a person's assertion must precede an agent's inference (Article P4)"
    end

    def test_context_carries_no_entry_from_another_channel
      @store.write(@other, title: "Campaign brief", detail: "Elsewhere.", trust: "human")
      @store.write(@channel, title: "Ours", detail: "Here.", trust: "human")

      refute_includes @store.context_for(@channel), "Campaign brief",
                      "the channel is the retrieval scope (Article P5)"
    end

    def test_context_respects_the_limit
      3.times { |i| @store.write(@channel, title: "Entry #{i}", detail: "d#{i}", key: "k#{i}") }

      context = @store.context_for(@channel, limit: 1)

      assert_equal 1, [ "Entry 0", "Entry 1", "Entry 2" ].count { |t| context.include?(t) }
    end

    # --- write ---------------------------------------------------------------

    def test_a_written_entry_lives_under_the_channels_region
      entry = @store.write(@channel, title: "T", detail: "D")

      assert entry.uri.start_with?(@channel.memory_uri),
             "#{entry.uri} must sit under #{@channel.memory_uri} (Article P5)"
    end

    def test_a_written_entry_keeps_its_trust_and_author
      alice = user
      entry = @store.write(@channel, title: "T", detail: "D", trust: "human", author: alice)

      assert_equal "human", entry.trust
      assert_equal alice.name, entry.author_name, "provenance must survive the write (Article P4)"
    end

    def test_write_defaults_to_agent_trust
      assert_equal "agent", @store.write(@channel, title: "T", detail: "D").trust,
                   "an unattributed write is an inference until someone says otherwise"
    end

    def test_overview_falls_back_to_the_detail_when_absent
      entry = @store.write(@channel, title: "T", detail: "The whole story.")

      assert entry.overview.present?, "the orientation tier is what gets pushed at session start"
    end

    def test_rewriting_a_key_supersedes_rather_than_destroys
      first  = @store.write(@channel, title: "Cadence", detail: "Weekly.",  key: "cadence")
      second = @store.write(@channel, title: "Cadence", detail: "Monthly.", key: "cadence")

      # A uri identifies an entry — a row id belongs to one store's table, and
      # the contract must not be able to tell which store it is talking to.
      refute_equal first.uri, second.uri
      assert_includes @store.context_for(@channel), "Monthly."
      refute_includes @store.context_for(@channel), "Weekly.",
                      "history is corrected by superseding, never by editing (Article P6)"
    end

    # --- the write policy ------------------------------------------------------
    #
    # What a key is derived from, what a collision does, and what fills the tiers
    # a caller left out. Both stores wrote those rules out for themselves, in
    # their own words — and two copies of a rule are two rules from the day one
    # of them is touched. The answer must not depend on which store the workspace
    # happens to be on, so every case below is asked of the store under test and
    # of no particular store (#177).
    #
    # What a correction leaves behind is asserted through what the room knows,
    # never through where the old entry went: one store leaves a superseded row,
    # the other moves the file to another scope, and no method on this seam reads
    # either. That superseding is not deleting is pinned where it can be seen —
    # `Memory::LocalTest`, against the row (Article P6).

    def test_a_title_written_again_corrects_what_was_there_however_often
      @store.write(@channel, title: "Reporting cadence", detail: "Weekly.")
      @store.write(@channel, title: "Reporting cadence", detail: "Monthly.")

      assert_equal [ "Monthly." ], @store.all(@channel).map(&:detail),
                   "a title is a key: writing under it again corrects rather than adds (Article P6)"

      @store.write(@channel, title: "Reporting cadence", detail: "Quarterly.")

      assert_equal [ "Quarterly." ], @store.all(@channel).map(&:detail),
                   "the third correction is the same act as the second"
      # A short deadline on purpose: this is a number that is already right or a
      # number that is wrong, and waiting out the full retrieval window for the
      # second kind turns a red run into a stalled one.
      assert_equal 1, retrieving(seconds: 10) { c = @store.count(@channel); c == 1 ? c : nil },
                   "a room that was told one thing three times knows one thing"
    end

    def test_a_skill_written_again_under_the_same_title_supersedes_the_old_one
      first  = @store.write_skill(@channel, title: "Running a client call", body: "Agenda first.")
      second = @store.write_skill(@channel, title: "Running a client call",
                                  body: "Agenda out the day before.")

      refute_equal first.uri, second.uri, "a uri identifies an entry; two of them cannot share one"
      assert_equal [ "Agenda out the day before." ], @store.skills(@channel).map(&:detail),
                   "a procedure is corrected the way a fact is (Article P6)"
    end

    # A title and a blank are two different things, and the policy owes them two
    # different answers. This is the first: "?!" is something a person wrote and
    # meant, and only its *key* is missing — so the entry is written, under a key
    # derived for it, with the tiers the write did not state filled in. What a
    # blank title gets is the case below.
    #
    # The second write is the half that matters here: a fallback key that is the
    # same string every time would file two unrelated entries under one name and
    # supersede the first with the second, which is a room forgetting rather than
    # being corrected.
    def test_a_title_with_no_key_in_it_is_still_written_and_still_gets_the_rest
      first  = @store.write(@channel, title: "?!", detail: "The whole story.")
      second = @store.write(@channel, title: "?!", detail: "A different story.")

      assert first.uri.start_with?(@channel.memory_uri),
             "#{first.uri}: a title with no key in it is still filed under the channel"
      refute_equal first.uri, second.uri,
                   "a key the title could not give is this write's own, not a constant every write shares"
      assert_equal 2, @store.all(@channel).size,
                   "two entries nothing connects, because nothing in their titles does"
      assert_equal "The whole story.", first.overview, "the orientation tier falls back to the detail"
      assert_equal "?!", first.abstract, "and the discovery tier to the title"
    end

    # An overview nobody wrote is the detail cut short, and the cut is the point
    # of it. `Store#context_for` renders overviews and nothing else, so this is
    # the length of what every session opens with — a fallback that keeps the
    # whole detail turns the orientation tier into the detail tier and pushes
    # kilobytes into an agent's opening context, one entry at a time, which no
    # assertion about the tier being *present* would ever notice.
    OVERVIEW_LIMIT = 400

    def test_an_overview_nobody_wrote_is_the_detail_cut_to_a_length
      detail = ("Everything the room worked out about the reporting cadence. " * 40).strip
      entry = @store.write(@channel, title: "The long story", detail: detail)
      skill = @store.write_skill(@channel, title: "The long procedure", body: detail)

      [ [ "an entry", entry ], [ "a skill", skill ] ].each do |what, written|
        assert_operator written.overview.length, :<=, OVERVIEW_LIMIT,
                        "#{what}: the tier a session opens with is bounded"
        refute_equal detail, written.overview,
                     "#{what}: an overview the size of the detail is not an overview"
        assert written.overview.start_with?("Everything the room worked out"),
               "#{what}: cut from the front of the detail, not composed from somewhere else"
      end

      assert_equal detail, @store.fetch(entry.uri).detail,
                   "and nothing was cut from the tier that is fetched on purpose"
    end

    # And the second answer: a blank title is refused. Not a key that could not
    # be derived — nothing to derive one from, and an entry the room could never
    # name afterwards.
    #
    # This is the one input the two stores answer differently today, and the
    # reason the policy becomes one. `Memory::Local#write` asks a nil title for
    # its parameterized form and hands back a NoMethodError from inside itself;
    # `Memory::OpenViking#write` derives a random key and writes a document with
    # no title in it that nothing will ever find. Neither is an answer a caller
    # can act on. Refusing was decided on the card rather than here, and an
    # ArgumentError is what a caller gets — through both doors, in the same
    # words, leaving the room knowing nothing new (#177).
    def test_a_write_the_room_could_not_name_is_refused_the_same_way_by_every_store
      [ nil, "", "   " ].each do |untitled|
        assert_raises(ArgumentError, "#{untitled.inspect} is not a title") do
          @store.write(@channel, title: untitled, detail: "Something worth knowing.")
        end

        assert_raises(ArgumentError, "#{untitled.inspect} is not a title for a skill either") do
          @store.write_skill(@channel, title: untitled, body: "Something worth doing.")
        end
      end

      assert_empty @store.all(@channel), "a write nobody can name is not what the room knows"
      assert_empty @store.skills(@channel), "and is not how work is done here either"
    end

    # --- provenance -----------------------------------------------------------
    #
    # Article P3 removed the human gate on the strength of provenance being
    # mandatory, and Article P4 calls an entry nobody can trace a defect. Both
    # stores answer the question the same way — one points at the run, the other
    # carries what the run said — so the answer is asserted through the one place
    # that reads either representation.

    def test_an_entry_an_agent_wrote_says_whose_agent_wrote_it
      alice = user(name: "Alice")
      run = agent_run(user: alice, channel: @channel)
      run.update!(model: "ChatGPT 5.5")

      written = @store.write(@channel, title: "Pricing objection", detail: "Setup cost, not price.",
                             trust: "agent", author: alice, source: run)
      who = Memory::Provenance.of(@store.fetch(written.uri))

      assert_equal "agent", who[:kind]
      assert_equal "Alice", who[:name], "an entry marked agent still belongs to a person (Article P4)"
      assert_equal "opencode", who[:agent_kind]
      assert_equal "ChatGPT 5.5", who[:model]
      assert_equal run.id, who[:run_id], "the entry must lead back to the turn that produced it"
    end

    def test_an_entry_a_person_wrote_has_an_author_and_no_run
      alice = user(name: "Alice")

      written = @store.write(@channel, title: "Reporting cadence", detail: "Monthly.",
                             trust: "human", author: alice)
      who = Memory::Provenance.of(@store.fetch(written.uri))

      assert_equal({ kind: "human", name: "Alice" }, who,
                   "a person was not a turn, and having no run is not a missing record")
    end

    def test_provenance_survives_superseding
      alice = user(name: "Alice")
      run = agent_run(user: alice, channel: @channel)
      written = @store.write(@channel, title: "Cadence", detail: "Weekly.", key: "cadence",
                             trust: "agent", author: alice, source: run)

      who = Memory::Provenance.of(@store.supersede(written.uri))

      assert_equal "Alice", who[:name]
      assert_equal run.id, who[:run_id],
                   "what the room used to know must still say where it came from (Article P6)"
    end

    # --- supersede ------------------------------------------------------------

    def test_an_agent_resolving_a_contradiction_supersedes_the_stale_entry
      stale = @store.write(@channel, title: "Cadence", detail: "Weekly.", key: "cadence")

      returned = @store.supersede(stale.uri, reason: "contradicted by a later run")

      assert_equal stale.uri, returned.uri
      assert_nil @store.context_for(@channel),
                 "history is corrected by superseding, and what was superseded leaves retrieval (Article P6)"
    end

    # A store supersedes the uri it is handed and nothing beside it. Which uris
    # an agent may hand it is the rail's question, not the store's — both stores
    # obey whatever they are given, so the answer cannot live in one of them.
    def test_superseding_here_leaves_another_room_knowing_what_it_knew
      ours = @store.write(@channel, title: "Cadence", detail: "Weekly.", key: "cadence")
      @store.write(@other, title: "Cadence", detail: "Weekly.", key: "cadence")

      @store.supersede(ours.uri)

      assert_empty @store.all(@channel)
      assert_equal [ "Cadence" ], @store.all(@other).map(&:title),
                   "a correction made in one room is not a correction in another (Article P5)"
    end

    def test_superseding_something_that_is_not_there_is_not_an_error
      assert_nil @store.supersede("#{@channel.memory_uri}nothing")
    end

    def test_superseding_twice_is_harmless
      entry = @store.write(@channel, title: "T", detail: "D", key: "t")
      @store.supersede(entry.uri)

      assert_nil @store.supersede(entry.uri), "already gone from current"
    end

    # --- enumeration ----------------------------------------------------------

    def test_all_returns_everything_the_room_knows
      # Not search with an empty query. A backend with real retrieval has no
      # reason to treat "" as "everything", and listing must not depend on it.
      @store.write(@channel, title: "One", detail: "first", key: "one")
      @store.write(@channel, title: "Two", detail: "second", key: "two")

      assert_equal %w[One Two], @store.all(@channel).map(&:title).sort
    end

    def test_all_never_crosses_into_another_channel
      @store.write(@other, title: "Elsewhere", detail: "not ours")
      @store.write(@channel, title: "Here", detail: "ours")

      assert_equal [ "Here" ], @store.all(@channel).map(&:title)
    end

    def test_all_omits_what_has_been_superseded
      @store.write(@channel, title: "Cadence", detail: "weekly", key: "cadence")
      @store.write(@channel, title: "Cadence", detail: "monthly", key: "cadence")

      assert_equal [ "monthly" ], @store.all(@channel).map(&:detail),
                   "a superseded entry is history, not what the room knows"
    end

    def test_all_puts_what_a_person_stated_before_what_an_agent_inferred
      @store.write(@channel, title: "Inferred", detail: "d", trust: "agent", key: "i")
      @store.write(@channel, title: "Stated", detail: "d", trust: "human", key: "s")

      assert_equal %w[Stated Inferred], @store.all(@channel).map(&:title)
    end

    def test_all_is_empty_for_a_room_that_knows_nothing
      assert_empty @store.all(@other)
    end

    # --- count ----------------------------------------------------------------
    #
    # A number the sidebar can afford. `all(...).size` would answer it too, and
    # would read every entry to do so — which is why this is a contract method
    # and not a caller counting for itself. Counting the table instead is how a
    # room that had learned things reported that it knew nothing (#99).

    def test_count_is_zero_for_a_room_that_knows_nothing
      assert_equal 0, @store.count(@other)
    end

    def test_count_is_what_the_room_currently_knows
      @store.write(@channel, title: "Reporting cadence", detail: "Monthly.", trust: "human")
      @store.write(@channel, title: "Pricing pattern", detail: "Setup cost.", trust: "agent")

      assert_equal 2, retrieving { c = @store.count(@channel); c == 2 ? c : nil }
    end

    def test_count_never_crosses_into_another_channel
      @store.write(@other, title: "Campaign brief", detail: "Elsewhere.", trust: "human")

      assert_equal 0, @store.count(@channel),
                   "a count that sees another room is the same defect as a listing that does"
    end

    # A procedure is not something the room learned. `all` excludes skills, so a
    # count that includes them describes a different set than the listing beside
    # it — and the number people see would rise when nobody learned anything.
    def test_count_excludes_skills
      @store.write_skill(@channel, title: "How we invoice", body: "Monthly, in arrears.")

      assert_equal 0, @store.count(@channel)
    end

    def test_count_drops_when_an_entry_is_superseded
      entry = @store.write(@channel, title: "Weekly", detail: "Weekly rollups.", key: "cadence")
      assert_equal 1, retrieving { c = @store.count(@channel); c == 1 ? c : nil }

      @store.supersede(entry.uri)

      assert_equal 0, retrieving { c = @store.count(@channel); c.zero? ? c : nil },
                   "what the room used to know is not what it knows"
    end

    def test_fetch_returns_the_entry_a_search_pointed_at
      written = @store.write(@channel, title: "Cadence", detail: "Monthly rollups, first Tuesday.")

      found = @store.fetch(written.uri)

      refute_nil found, "the rail executes against a uri; a store that cannot be asked for one is useless to it"
      assert_equal "Cadence", found.title
      assert_includes found.detail, "first Tuesday"
    end

    def test_fetch_is_nil_for_something_that_is_not_there
      assert_nil @store.fetch("#{@channel.memory_uri}nothing-here.md")
    end

    def test_fetch_does_not_return_a_superseded_entry
      entry = @store.write(@channel, title: "Weekly", detail: "Weekly rollups.", key: "cadence")
      @store.supersede(entry.uri)

      assert_nil @store.fetch(entry.uri), "what the room used to know is not what it knows"
    end

    # --- skills ---------------------------------------------------------------

    def test_a_skill_is_kept_apart_from_what_the_room_knows
      # "Acme wants monthly reporting" will one day be wrong. "Recap decisions
      # before the call ends" will not. Mixing them is how a rules file rots.
      @store.write(@channel, title: "Reporting cadence", detail: "Monthly.")
      @store.write_skill(@channel, title: "Running a client call",
                         body: "Agenda out the day before. Recap decisions before it ends.")

      assert_equal [ "Running a client call" ], @store.skills(@channel).map(&:title)
      assert_equal [ "Reporting cadence" ], @store.all(@channel).map(&:title),
                   "a procedure is not something the room learned"
    end

    def test_a_skill_sits_under_the_channel_that_owns_it
      skill = @store.write_skill(@channel, title: "Running a client call", body: "Agenda first.")

      assert skill.uri.start_with?(@channel.skills_uri),
             "#{skill.uri} must sit under #{@channel.skills_uri} — the uri is the permission"
    end

    def test_a_skill_never_crosses_into_another_channel
      @store.write_skill(@other, title: "Elsewhere", body: "Not ours.")
      @store.write_skill(@channel, title: "Here", body: "Ours.")

      assert_equal [ "Here" ], @store.skills(@channel).map(&:title)
    end

    def test_a_skill_can_be_read_in_full_by_its_uri
      skill = @store.write_skill(@channel, title: "Running a client call",
                                 body: "Agenda out the day before. Recap decisions before it ends.")

      found = @store.fetch(skill.uri)

      refute_nil found, "the rail executes a skill by uri, the same as anything else"
      assert_includes found.detail, "Recap decisions"
    end

    def test_the_room_knowing_nothing_is_not_the_room_having_no_skills
      @store.write_skill(@channel, title: "Running a client call", body: "Agenda first.")

      assert_nil @store.context_for(@channel),
                 "a skill is not pushed into a session; it is found when it is wanted"
    end

    # --- search --------------------------------------------------------------

    def test_search_finds_an_entry_by_its_content
      @store.write(@channel, title: "Acme", detail: "asked for monthly rollups")

      assert_equal [ "Acme" ], retrieving { @store.search(@channel, "rollups") }.map(&:title)
    end

    def test_search_is_empty_when_nothing_matches
      @store.write(@channel, title: "Acme", detail: "monthly rollups")

      assert_empty @store.search(@channel, "quarterly zebras")
    end

    def test_search_never_crosses_into_another_channel
      @store.write(@other, title: "Elsewhere", detail: "shared word")
      @store.write(@channel, title: "Here", detail: "shared word")

      assert_equal [ "Here" ], retrieving { @store.search(@channel, "shared word") }.map(&:title)
    end

    # An agent does not search for keywords. It passes the question it was asked.
    def test_search_answers_a_question_not_only_a_keyword
      @store.write(@channel, title: "Acme wants monthly reporting",
                             detail: "Weekly created noise and nobody read it.")

      assert_equal [ "Acme wants monthly reporting" ],
                   retrieving { @store.search(@channel, "what did we agree with Acme about reporting?") }.map(&:title),
                   "a query that reads like a sentence must still find what the room knows"
    end

    def test_search_puts_the_entry_matching_more_of_the_question_first
      @store.write(@channel, title: "Acme reporting cadence", detail: "Acme asked for monthly reporting")
      @store.write(@channel, title: "Reporting", detail: "generic note about reporting")

      assert_equal "Acme reporting cadence",
                   retrieving { @store.search(@channel, "Acme reporting cadence") }.first.title,
                   "the entry answering more of the question comes first"
    end

    def test_search_ignores_superseded_entries
      @store.write(@channel, title: "Cadence", detail: "weekly rhythm", key: "cadence")
      @store.write(@channel, title: "Cadence", detail: "monthly rhythm", key: "cadence")

      assert_equal [ "monthly rhythm" ], retrieving { @store.search(@channel, "rhythm") }.map(&:detail)
    end
  end
end

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
      assert_equal alice, entry.author, "provenance must survive the write (Article P4)"
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

      refute_equal first.id, second.id
      assert MemoryEntry.find(first.id).superseded_at,
             "history is corrected by superseding, never by editing (Article P6)"
      assert_includes @store.context_for(@channel), "Monthly."
      refute_includes @store.context_for(@channel), "Weekly."
    end

    # --- supersede ------------------------------------------------------------

    def test_an_agent_resolving_a_contradiction_supersedes_the_stale_entry
      stale = @store.write(@channel, title: "Cadence", detail: "Weekly.", key: "cadence")

      returned = @store.supersede(stale.uri, reason: "contradicted by a later run")

      assert_equal stale.id, returned.id
      assert stale.reload.superseded_at, "history is corrected by superseding (Article P6)"
      assert_nil @store.context_for(@channel), "a superseded entry leaves retrieval"
    end

    def test_superseding_something_that_is_not_there_is_not_an_error
      assert_nil @store.supersede("#{@channel.memory_uri}nothing")
    end

    def test_superseding_twice_is_harmless
      entry = @store.write(@channel, title: "T", detail: "D", key: "t")
      @store.supersede(entry.uri)

      assert_nil @store.supersede(entry.uri), "already gone from current"
    end

    # --- search --------------------------------------------------------------

    def test_search_finds_an_entry_by_its_content
      @store.write(@channel, title: "Acme", detail: "asked for monthly rollups")

      assert_equal [ "Acme" ], @store.search(@channel, "rollups").map(&:title)
    end

    def test_search_is_empty_when_nothing_matches
      @store.write(@channel, title: "Acme", detail: "monthly rollups")

      assert_empty @store.search(@channel, "quarterly zebras")
    end

    def test_search_never_crosses_into_another_channel
      @store.write(@other, title: "Elsewhere", detail: "shared word")
      @store.write(@channel, title: "Here", detail: "shared word")

      assert_equal [ "Here" ], @store.search(@channel, "shared word").map(&:title)
    end

    def test_search_ignores_superseded_entries
      @store.write(@channel, title: "Cadence", detail: "weekly rhythm", key: "cadence")
      @store.write(@channel, title: "Cadence", detail: "monthly rhythm", key: "cadence")

      assert_equal [ "monthly rhythm" ], @store.search(@channel, "rhythm").map(&:detail)
    end
  end
end

module RecordStore
  # The room as a folder. The journal already holds what happened and in which
  # order; this replays it into a git repository, one commit per entry, so that
  # `git log` over a directory answers "what does this room know, and when did
  # it learn it" without the server, the database, or an account.
  #
  # One way only, and never a source of truth — docs/spikes/filesystem.md says
  # why at length. The consequence here is that the export reads and the mirror
  # is its own artifact: a second run fast-forwards, and a repository that
  # disagrees with the journal stops it rather than being forced into line.
  #
  # Nothing is asked of anything but the journal. The bytes of an entry are in
  # the object store, and everything the mirror says comes out of them — a
  # memory entry's detail included, because a record that needs a live context
  # store to be replayed is a cache of one rather than a record.
  class GitExport
    # In the repository, not beside it: a mirror somebody copies to another
    # machine carries where it got to, and the pair is what the next run checks
    # itself against.
    STATE = ".workroom-export.json".freeze

    # The export vouches for the commit; the entry vouches for the author. Two
    # different questions, and only the first one this code can answer.
    COMMITTER_NAME = "WorkRoom".freeze
    COMMITTER_EMAIL = "record@workroom.local".freeze

    # A subject is a line. git tools truncate one for themselves anyway, and a
    # `git log --oneline` of wrapped paragraphs is the noise this avoids.
    SUBJECT_LIMIT = 60

    # Not an argument error and not a bug: the mirror and the journal disagree,
    # and the only safe move is to stop. Named so a caller can tell it from the
    # ordinary failures of writing files.
    ChainMismatch = Class.new(StandardError)

    Result = Struct.new(:entries_exported, :head_sha, :repo_path)

    def self.call(channel, path:) = new(channel, path).call

    def initialize(channel, path)
      @channel = channel
      @path = File.expand_path(path)
    end

    def call
      initialize_repository
      state = state_on_disk
      seq = state["last_seq"].to_i
      hash = state["last_hash"]
      exported = 0

      @channel.channel_records.where(seq: (seq + 1)..).order(:seq).each do |entry|
        # Every entry names the one before it, so replaying them in order is
        # also checking them: a hole in the middle cannot be committed as if the
        # room had gone quiet.
        unless entry.prev_hash == (hash || Append::GENESIS)
          raise ChainMismatch, "seq #{entry.seq} does not follow what #{STATE} says was exported"
        end

        exported += 1 if commit(entry)
        seq = entry.seq
        hash = entry.entry_hash
      end

      write_state(seq, hash)
      Result.new(exported, head_sha, @path)
    end

    private
      def initialize_repository
        return if File.directory?(File.join(@path, ".git"))

        FileUtils.mkdir_p(@path)
        # The branch is named rather than left to whatever this machine
        # defaults to, so two mirrors of the same room are the same repository.
        git("-c", "init.defaultBranch=main", "init", "-q")
      end

      # Where the last run got to, and which room it was mirroring. A repository
      # that already holds commits and cannot say is refused: it is somebody
      # else's history, and committing a room's whole journal on top of it would
      # be the fork this file exists to prevent.
      def state_on_disk
        file = File.join(@path, STATE)
        return verified(JSON.parse(File.read(file))) if File.exist?(file)

        if head_sha
          raise ChainMismatch, "#{@path} already holds commits and no #{STATE} — it is not this room's mirror"
        end

        { "last_seq" => 0, "last_hash" => nil }
      end

      def verified(state)
        unless state["channel"] == @channel.slug && state["workspace"] == @channel.workspace.slug
          raise ChainMismatch,
                "#{@path} mirrors #{state['workspace']}/#{state['channel']}, not " \
                "#{@channel.workspace.slug}/#{@channel.slug}"
        end

        # Slugs are unique per workspace and a workspace can be renamed, so the
        # names above are a courtesy. What settles it is the entry the mirror
        # claims to have stopped at: it has to be in this journal, at that
        # number, with that hash.
        last_seq = state["last_seq"].to_i
        return state if last_seq.zero?

        anchor = @channel.channel_records.find_by(seq: last_seq)
        return state if anchor && anchor.entry_hash == state["last_hash"]

        raise ChainMismatch,
              "#{STATE} says seq #{last_seq} was #{state['last_hash'].inspect}, " \
              "which is not what this room's journal says"
      end

      def write_state(seq, hash)
        File.write(File.join(@path, STATE), JSON.pretty_generate(
          "channel" => @channel.slug, "workspace" => @channel.workspace.slug,
          "last_seq" => seq, "last_hash" => hash
        ) + "\n")
      end

      # One entry, one commit. False when the entry maps to no file at all —
      # a kind this export does not know is passed over rather than committed
      # blind, and the run still moves on from it.
      def commit(entry)
        envelope = JSON.parse(Objects.current.get(entry.entry_hash))
        payload = envelope["payload"] || {}
        occurred = Time.iso8601(envelope["occurred_at"]).utc

        return false unless materialize(entry.kind, payload, occurred)

        write_state(entry.seq, entry.entry_hash)
        name, email = author_of(entry.kind, payload)
        git("add", "-A")
        git("commit", "-q", "-m", subject_for(entry.kind, payload),
            env: identity(name, email, occurred))
        true
      end

      def materialize(kind, payload, occurred)
        case kind
        when "message.created" then write_message(payload, occurred)
        when "memory"          then write_memory(payload, occurred)
        when "artifact"        then write_artifact(payload)
        else                        false
        end
      end

      # A month per file, appended to. The whole conversation in one file is
      # unreadable by the third year, and a file per message is a directory
      # nobody can open.
      def write_message(payload, occurred)
        file = repo_file("messages", "#{occurred.strftime('%Y-%m')}.jsonl")
        File.open(file, "a") { |f| f.puts(JSON.generate(payload)) }
        true
      end

      # The shape the spike printed: provenance a reader can see without asking
      # anything, and the entry itself underneath it.
      def write_memory(payload, occurred)
        front = {
          "uri" => payload["uri"], "trust" => payload["trust"],
          "author" => memory_author_name(payload), "run" => payload["run_id"],
          "recorded" => occurred.iso8601
        }.compact

        File.write(repo_file("memory", "#{memory_key(payload['uri'])}.md"),
                   "#{YAML.dump(front)}---\n\n#{memory_body(payload)}")
        true
      end

      # A correction says why; what it corrects is one commit back, and the file
      # is the same file because the uri is the same uri (Article P3).
      def memory_body(payload)
        return "Superseded: #{payload['reason']}\n" if payload["action"] == "supersede"

        title = payload["title"].presence || memory_key(payload["uri"])
        [ "# #{title}\n", payload["detail"].presence ].compact.join("\n") + "\n"
      end

      def write_artifact(payload)
        File.binwrite(repo_file("artifacts", filename(payload["name"])),
                      Objects.current.get(payload["sha256"]))
        true
      end

      def subject_for(kind, payload)
        case kind
        when "message.created"
          payload["body"].to_s.lines.first.to_s.strip.slice(0, SUBJECT_LIMIT).presence || "message"
        when "memory"
          "#{payload['action']}: #{payload['title'].presence || memory_key(payload['uri'])}"
        when "artifact"
          "artifact: #{payload['name']}"
        end
      end

      # Who the entry came from, in git's own terms. A person is themselves; an
      # agent is theirs, at an address naming the turn — so `git log --author`
      # separates what somebody said from what their agent inferred, which is
      # the distinction Article P4 exists to keep.
      def author_of(kind, payload)
        case kind
        when "message.created" then message_author(payload["author"] || {})
        when "memory"          then memory_author(payload)
        when "artifact"        then agent_author(person_behind(payload["run_id"]), payload["run_id"])
        end
      end

      def message_author(author)
        return agent_author(author["name"], author["run_id"]) if author["kind"] == "agent"

        [ author["name"], author["email"] ]
      end

      def memory_author(payload)
        person = User.find_by(id: payload["author_id"])
        return agent_author(person&.name, payload["run_id"]) if payload["trust"] == "agent"

        person ? [ person.name, person.email ] : [ COMMITTER_NAME, COMMITTER_EMAIL ]
      end

      def agent_author(person_name, run_id)
        return [ COMMITTER_NAME, COMMITTER_EMAIL ] if person_name.blank?

        [ "#{person_name}'s agent", "agent+#{run_id}@workroom.local" ]
      end

      def memory_author_name(payload)
        name, = memory_author(payload)
        name
      end

      def person_behind(run_id) = AgentRun.find_by(id: run_id)&.agent_session&.user&.name

      # A name in an envelope is content: it chose neither the directory nor the
      # path, and an export that joined it onto one would write wherever an
      # uploader asked it to. The basename first, because that is what a
      # traversal is, and then a scrub of everything a directory separator could
      # be rebuilt from.
      def filename(name)
        File.basename(name.to_s).gsub(/[^\w.\- ]/, "").sub(/\A[.\s]+/, "").presence || "artifact"
      end

      # The file is named from the uri, not the title. A store mints tails a
      # title cannot reproduce, and a correction carries no title at all — so
      # the uri is the only thing a write and its supersession agree on.
      def memory_key(uri)
        tail = uri.to_s.split("/").last.to_s.delete_suffix(".md")
        tail.parameterize.presence || "entry"
      end

      def repo_file(directory, name)
        FileUtils.mkdir_p(File.join(@path, directory))
        File.join(@path, directory, name)
      end

      # --verify -q, so a repository with no commits yet answers nothing rather
      # than echoing "HEAD" back and reading as a history that is already there.
      def head_sha = git("rev-parse", "--verify", "-q", "HEAD", check: false).presence

      def identity(name, email, occurred)
        {
          "GIT_AUTHOR_NAME" => name, "GIT_AUTHOR_EMAIL" => email,
          "GIT_AUTHOR_DATE" => occurred.iso8601,
          "GIT_COMMITTER_NAME" => COMMITTER_NAME, "GIT_COMMITTER_EMAIL" => COMMITTER_EMAIL,
          "GIT_COMMITTER_DATE" => occurred.iso8601
        }
      end

      # Identity and dates travel in the environment of the one command that
      # needs them, so nothing here writes to a git config — the operator's own
      # or the repository's. Theirs is read out of the way for the same reason:
      # a global hook, a signing key or an excludes file is a machine's
      # preference, and the mirror of a room must not depend on whose machine
      # made it.
      def git(*args, env: {}, check: true)
        out, err, status = Open3.capture3(
          env.merge("GIT_CONFIG_GLOBAL" => File::NULL, "GIT_CONFIG_SYSTEM" => File::NULL),
          "git", "-C", @path, *args
        )
        raise "git #{args.first} failed in #{@path}: #{err.strip}" if check && !status.success?

        out.strip
      end
  end
end

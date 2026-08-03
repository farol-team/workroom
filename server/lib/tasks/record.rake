namespace :record do
  desc "Re-read a room's journal and prove the chain from the bytes — record:verify[slug], or every room"
  task :verify, [ :slug ] => :environment do |_task, args|
    slug = args[:slug]
    checked = 0
    broken = []

    # Every workspace, entered one at a time, because the boundary is the
    # database's: a connection that has entered nothing sees no rooms, and a
    # checker that reports success by finding nothing to check is worse than no
    # checker. It looks unnecessary from a psql that bypasses row-level
    # security, which is exactly the connection nobody should be trusting here.
    #
    # Wrapped in one transaction of its own: Workspace#entered puts the
    # previous scope back with SET LOCAL after its own transaction has closed,
    # which outside one is a no-op and a warning on every room. Read-only work,
    # so a single snapshot over all of it costs nothing and reads the record as
    # it stood at one moment.
    ActiveRecord::Base.transaction do
      Workspace.find_each do |workspace|
        workspace.entered do
          rooms = slug ? Array(Channel.find_by(slug:)) : Channel.order(:slug).to_a

          rooms.each do |room|
            checked += 1
            # Slugs are unique per workspace, not globally, so a bare slug
            # names as many rooms as there are workspaces holding one.
            label = "#{workspace.slug}/#{room.slug}"
            result = RecordStore::Verify.call(room)

            if result.ok?
              puts "#{label}: OK (#{result.entries} entries)"
            else
              broken << label
              result.failures.each { |failure| puts "#{label}: #{failure}" }
            end
          end
        end
      end
    end

    # Nonzero, because this is a check and a check nobody can wire into
    # anything is a report. `abort` prints to stderr and leaves the lines above
    # on stdout, so a pipe keeps the findings and the shell keeps the verdict.
    abort "no room anywhere is called #{slug}" if slug && checked.zero?
    abort "the record does not verify: #{broken.join(", ")}" if broken.any?
  end

  desc "Mirror a room's journal into a git repository — record:export[slug,path]"
  task :export, [ :slug, :path ] => :environment do |_task, args|
    slug = args[:slug]
    path = args[:path]
    abort "record:export[slug,path] needs both a room and a directory" if slug.blank? || path.blank?

    # The same walk record:verify makes, and for the same reason: the boundary
    # is the database's, so a connection that has entered no workspace sees no
    # rooms — and a mirror of nothing, written over the folder the operator
    # named, is the worst answer available.
    ActiveRecord::Base.transaction do
      rooms = Workspace.all.filter_map do |workspace|
        room = workspace.entered { Channel.find_by(slug:) }
        [ workspace, room ] if room
      end

      abort "no room anywhere is called #{slug}" if rooms.empty?

      # verify can check every room of that name; this writes to one directory,
      # so there is no answer that serves both — and either one fills the
      # operator's folder with a workspace's record they did not choose.
      if rooms.length > 1
        abort "#{slug} is a room in #{rooms.map { |ws, _| ws.slug }.join(', ')} — " \
              "one folder holds one room's record"
      end

      workspace, room = rooms.first
      workspace.entered do
        result = RecordStore::GitExport.call(room, path: path)
        puts "#{workspace.slug}/#{room.slug}: #{result.entries_exported} entries -> #{result.repo_path}"
      end
    end
  rescue RecordStore::GitExport::ChainMismatch => e
    # A mirror that has forked from the journal is a finding, not a crash: the
    # shell gets a verdict it can wire into something, without a backtrace on
    # top of the one sentence that says what happened.
    abort "the mirror does not follow the record: #{e.message}"
  end
end
